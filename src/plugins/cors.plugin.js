import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import { env } from '../config/env.js'

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

async function corsPlugin(fastify) {
  const configuredOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3001']
  const origins = expandLoopbackOrigins(configuredOrigins)

  await fastify.register(cors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Total-Count', 'X-Total-Pages'],
    maxAge: 86400,
  })
}

export default fp(corsPlugin, { name: 'cors' })
