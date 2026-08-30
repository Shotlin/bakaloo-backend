import { OlaMapsController } from './ola-maps.controller.js'
import { OlaMapsService } from './ola-maps.service.js'
import { styleUrlSchema, geocodeSchema, reverseGeocodeSchema } from './ola-maps.schema.js'

/**
 * Ola Maps routes plugin — Beta/test module
 * Prefix: /api/v1/maps/ola
 * All routes require authentication (this proxies a paid, quota-limited
 * third-party API — never expose it unauthenticated).
 */
export default async function olaMapsRoutes(fastify) {
  const service = new OlaMapsService()
  const controller = new OlaMapsController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  // GET /style-url — MapLibre style URL for the mobile map widget
  fastify.get('/style-url', {
    schema: styleUrlSchema,
  }, controller.getStyleUrl.bind(controller))

  // GET /geocode — forward geocode (address -> coordinates)
  fastify.get('/geocode', {
    schema: geocodeSchema,
  }, controller.geocode.bind(controller))

  // GET /reverse-geocode — reverse geocode (coordinates -> address)
  fastify.get('/reverse-geocode', {
    schema: reverseGeocodeSchema,
  }, controller.reverseGeocode.bind(controller))
}
