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
    // X-Shop-Id is set by the dashboard's axios interceptor for every
    // shop-scoped request (multi-vendor design — see dashboard
    // src/lib/api.ts and design.md "X-Shop-Id Interceptor"). Must be in
    // allowedHeaders so the browser preflight passes. Without it, every
    // shop-scoped GET/POST fails with net::ERR_FAILED at the browser.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Shop-Id'],
    exposedHeaders: ['X-Total-Count', 'X-Total-Pages'],
    maxAge: 86400,
  })
}

export default fp(corsPlugin, { name: 'cors' })
