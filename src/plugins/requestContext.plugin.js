import fp from 'fastify-plugin'
import { AsyncLocalStorage } from 'node:async_hooks'

// Request-scoped context (currently just ip/userAgent) so utilities like
// logAdminActivity() can pick up the User-Agent without every one of its
// ~77 call sites across 17 admin modules having to thread an extra
// parameter through their controller -> service -> logger chain the way
// `ip` historically had to be. setImmediate() callbacks (which is how
// logAdminActivity fires) still see the store set by onRequest below,
// since AsyncLocalStorage follows the async chain, not just direct calls.
export const requestContext = new AsyncLocalStorage()

async function requestContextPlugin(fastify) {
  fastify.addHook('onRequest', (request, reply, done) => {
    requestContext.run(
      { ip: request.ip, userAgent: request.headers['user-agent'] || null },
      done
    )
  })
}

export default fp(requestContextPlugin, { name: 'requestContext' })
