import fp from 'fastify-plugin'
import { Server } from 'socket.io'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import jwt from 'jsonwebtoken'
import { redis } from '../config/redis.js'
import { query } from '../config/database.js'

const RIDER_LOCATION_PREFIX = 'rider:location:'
const RIDER_LOCATION_TTL = 300 // 5 minutes
let activeIo = null

function expandLoopbackOrigins(originList) {
  const expanded = new Set(originList)

  for (const origin of originList) {
    try {
      const url = new URL(origin)
      if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1'
        expanded.add(url.toString().replace(/\/$/, ''))
      } else if (url.hostname === '127.0.0.1') {
        url.hostname = 'localhost'
        expanded.add(url.toString().replace(/\/$/, ''))
      }
    } catch {
      expanded.add(origin)
    }
  }

  return Array.from(expanded)
}

export function getSocketIo() {
  return activeIo
}

export function emitSectionUpdate(io, tabKey, action) {
  if (!io) return

  io.to('themes:live').emit('section:update', {
    tab_key: tabKey,
    action,
    timestamp: Date.now(),
  })
  logger.info({ tabKey, action }, 'Section update broadcasted to all users')
}

/**
 * Socket.IO plugin for Fastify
 * Handles realtime: rider location, order status, notifications
 *
 * Rooms:
 *   user:{userId}       — personal room for order updates + notifications
 *   order:{orderId}     — order tracking room (customer + rider + admin)
 *   riders:online       — all online riders (admin dashboard)
 */
async function socketioPlugin(fastify) {
  const corsOrigins = expandLoopbackOrigins(
    env.CORS_ORIGINS.split(',').map((s) => s.trim())
  )

  const io = new Server(fastify.server, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  })

  // ─── AUTH MIDDLEWARE ──────────────────────────────────
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '')

    if (!token) {
      return next(new Error('Authentication required'))
    }

    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET)
      socket.user = decoded // { id, phone, role }
      next()
    } catch (err) {
      logger.warn({ err: err.message }, 'Socket auth failed')
      next(new Error('Invalid or expired token'))
    }
  })

  // ─── CONNECTION HANDLER ──────────────────────────────
  io.on('connection', (socket) => {
    const { id: userId, role } = socket.user

    logger.info({ userId, socketId: socket.id, role }, 'Socket connected')

    // Auto-join personal room
    socket.join(`user:${userId}`)

    // ─── RIDER EVENTS ────────────────────────────────
    if (role === 'RIDER') {
      socket.join('riders:online')

      // Rider sends location updates
      socket.on('rider:location', async (data) => {
        try {
          const latitude = Number(data?.latitude ?? data?.lat)
          const longitude = Number(data?.longitude ?? data?.lng)
          const orderId = data?.orderId

          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return
          }

          // Store in Redis (fast reads for proximity)
          await redis.setex(
            `${RIDER_LOCATION_PREFIX}${userId}`,
            RIDER_LOCATION_TTL,
            JSON.stringify({ lat: latitude, lng: longitude, updatedAt: Date.now() })
          )

          // Persist latest coordinates in DB for assignment fallback.
          await query(
            `UPDATE rider_profiles
             SET current_lat = $1, current_lng = $2, updated_at = NOW()
             WHERE user_id = $3`,
            [latitude, longitude, userId]
          )

          // Broadcast to order room (customer tracking)
          if (orderId) {
            io.to(`order:${orderId}`).emit('rider:location:update', {
              orderId,
              riderId: userId,
              latitude,
              longitude,
              timestamp: Date.now(),
            })
          }

          // Broadcast to admin
          io.to('riders:online').emit('rider:location:bulk', {
            riderId: userId,
            latitude,
            longitude,
            timestamp: Date.now(),
          })
        } catch (err) {
          logger.error({ err, userId }, 'Rider location update failed')
        }
      })

      // Rider goes offline
      socket.on('rider:offline', async () => {
        await redis.del(`${RIDER_LOCATION_PREFIX}${userId}`)
        socket.leave('riders:online')
        logger.info({ userId }, 'Rider went offline')
      })
    }

    // ─── ORDER TRACKING ──────────────────────────────
    socket.on('order:track', (orderId) => {
      if (orderId) {
        socket.join(`order:${orderId}`)
        logger.debug({ userId, orderId }, 'Joined order tracking room')
      }
    })

    socket.on('order:untrack', (orderId) => {
      if (orderId) {
        socket.leave(`order:${orderId}`)
      }
    })

    // ─── ADMIN EVENTS ────────────────────────────────
    if (role === 'ADMIN') {
      socket.join('admin:dashboard')
    }

    // ─── THEME EVENTS ────────────────────────────────
    // All authenticated users join themes:live room for real-time theme updates
    socket.join('themes:live')

    // ─── DISCONNECT ──────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected')

      // Clean up rider location on disconnect
      if (role === 'RIDER') {
        await redis.del(`${RIDER_LOCATION_PREFIX}${userId}`)
      }
    })
  })

  // ─── DECORATE FASTIFY ────────────────────────────────
  fastify.decorate('io', io)
  activeIo = io

  // Helper: emit order status update to customer + rider + admin
  fastify.decorate('emitOrderUpdate', (orderId, userIdsOrData, maybeData) => {
    const payload = maybeData === undefined ? userIdsOrData : maybeData
    const userIds = maybeData === undefined
      ? []
      : Array.isArray(userIdsOrData)
        ? userIdsOrData.filter(Boolean)
        : userIdsOrData
          ? [userIdsOrData]
          : []
    const data = {
      orderId,
      timestamp: new Date().toISOString(),
      ...(payload || {}),
    }

    io.to(`order:${orderId}`).emit('order:status', data)
    for (const userId of userIds) {
      io.to(`user:${userId}`).emit('order:status', data)
    }
    io.to('admin:dashboard').emit('order:status', data)
  })

  fastify.decorate('emitOrderAssignedToRider', (riderId, data) => {
    if (!riderId) return
    io.to(`user:${riderId}`).emit('order:assigned', data)
  })

  fastify.decorate('emitOrderExpiredToRider', (riderId, data) => {
    if (!riderId) return
    io.to(`user:${riderId}`).emit('order:expired', data)
  })

  // Helper: send personal notification to user
  fastify.decorate('emitNotification', (userId, notification) => {
    io.to(`user:${userId}`).emit('notification', notification)
  })

  // Helper: get rider's latest location from Redis
  fastify.decorate('getRiderLocation', async (riderId) => {
    const data = await redis.get(`${RIDER_LOCATION_PREFIX}${riderId}`)
    return data ? JSON.parse(data) : null
  })

  // ─── ADMIN DASHBOARD EVENTS ──────────────────────────
  // Helper: emit new order alert to admin dashboard
  fastify.decorate('emitDashboardNewOrder', (order) => {
    io.to('admin:dashboard').emit('dashboard:new_order', order)
  })

  // Helper: emit low stock alert to admin dashboard
  fastify.decorate('emitDashboardLowStock', (product) => {
    io.to('admin:dashboard').emit('dashboard:low_stock', product)
  })

  // Helper: emit payment received to admin dashboard
  fastify.decorate('emitDashboardPayment', (payment) => {
    io.to('admin:dashboard').emit('dashboard:payment_received', payment)
  })

  // Helper: broadcast theme update to ALL connected users
  fastify.decorate('emitThemeUpdate', (tabKey, themeId) => {
    io.to('themes:live').emit('theme:update', {
      tabKey,
      themeId,
      timestamp: new Date().toISOString(),
    })
    logger.info({ tabKey, themeId }, 'Theme update broadcasted to all users')
  })

  // Periodic: broadcast all rider locations to admin dashboard every 10s
  const riderLocationInterval = setInterval(async () => {
    try {
      const keys = await redis.keys(`${RIDER_LOCATION_PREFIX}*`)
      if (keys.length === 0) return

      const pipeline = redis.pipeline()
      keys.forEach(k => pipeline.get(k))
      const results = await pipeline.exec()

      const locations = keys.map((key, i) => {
        const riderId = key.replace(RIDER_LOCATION_PREFIX, '')
        const data = results[i][1] ? JSON.parse(results[i][1]) : null
        return data ? { riderId, ...data } : null
      }).filter(Boolean)

      if (locations.length > 0) {
        io.to('admin:dashboard').emit('dashboard:rider_locations', locations)
      }
    } catch (err) {
      logger.error({ err }, 'Rider location broadcast failed')
    }
  }, 10000)

  // Cleanup interval on close
  fastify.addHook('onClose', () => {
    clearInterval(riderLocationInterval)
    io.close()
  })

  logger.info('Socket.IO initialized')
}

export default fp(socketioPlugin, {
  name: 'socketio',
})
