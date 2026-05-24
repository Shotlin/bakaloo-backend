import { AllocationController } from './allocation.controller.js'
import { AllocationService } from './allocation.service.js'
import { AllocationRepository } from './allocation.repository.js'

/**
 * Allocation routes plugin
 * Prefix: /api/v1/allocation
 *
 * Endpoints:
 *   - GET  /my-shops   — Any authenticated user (customer view)
 *   - POST /recompute  — ADMIN role OR self (user_id matches JWT)
 *                        Rate-limited to 10/min to prevent recompute storms.
 */
export default async function allocationRoutes(fastify) {
  const repository = new AllocationRepository()
  const service = new AllocationService(repository)
  const controller = new AllocationController(service)

  // ── GET /my-shops ───────────────────────────────────────
  fastify.get(
    '/my-shops',
    {
      schema: {
        tags: ['Allocation'],
        summary: 'List shops allocated to the current user',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  shops: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        shop_id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        distance_km: { type: ['number', 'null'] },
                        matched_pincode: { type: ['string', 'null'] },
                        is_primary: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.myShops.bind(controller)
  )

  // ── POST /recompute ─────────────────────────────────────
  // Caller must be ADMIN or pass own user_id (controller enforces).
  fastify.post(
    '/recompute',
    {
      schema: {
        tags: ['Allocation'],
        summary: 'Recompute allocations for a user (ADMIN or self)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            user_id: { type: 'string', format: 'uuid' },
            address: {
              type: 'object',
              required: ['lat', 'lng', 'pincode'],
              properties: {
                lat: { type: 'number', minimum: -90, maximum: 90 },
                lng: { type: 'number', minimum: -180, maximum: 180 },
                pincode: { type: 'string', minLength: 1, maxLength: 10 },
              },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    controller.recompute.bind(controller)
  )
}
