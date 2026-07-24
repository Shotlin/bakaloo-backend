import { CoverageMapController } from './coverage-map.controller.js'
import { CoverageMapService } from './coverage-map.service.js'
import { CoverageMapRepository } from './coverage-map.repository.js'

const coverageResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: {
      type: 'object',
      properties: {
        shop: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            lat: { type: 'number' },
            lng: { type: 'number' },
            city: { type: 'string' },
            state: { type: 'string' },
            pincode: { type: 'string' },
            isActive: { type: 'boolean' },
          },
        },
        serviceablePincodes: { type: 'array', items: { type: 'string' } },
        uncoveredPincodes: { type: 'array', items: { type: 'string' } },
        customers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              name: { type: ['string', 'null'] },
              initial: { type: 'string' },
              lat: { type: 'number' },
              lng: { type: 'number' },
              pincode: { type: ['string', 'null'] },
            },
          },
        },
        boundaries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pincode: { type: 'string' },
              count: { type: 'integer' },
              polygon: {
                type: 'array',
                items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              },
            },
          },
        },
        totalCustomers: { type: 'integer' },
      },
    },
  },
}

/**
 * Coverage Map admin routes plugin.
 * Prefix: /api/v1/admin/coverage-map
 *
 * Powers the dashboard's "Store Coverage Map" — a store's pin, its
 * serviceable-pincode boundary shapes (derived live from real customer
 * addresses, see coverage-map.service.js), and every currently-covered
 * customer's pin.
 */
export default async function coverageMapRoutes(fastify) {
  const repository = new CoverageMapRepository()
  const service = new CoverageMapService(repository)
  const controller = new CoverageMapController(service)

  fastify.get('/:shopId', {
    schema: {
      tags: ['Coverage Map'],
      summary: 'Get a shop\'s customer coverage map [ADMIN]',
      params: {
        type: 'object',
        required: ['shopId'],
        properties: { shopId: { type: 'string', format: 'uuid' } },
      },
      response: { 200: coverageResponse },
    },
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.getCoverage.bind(controller))
}
