import { OlaMapsController } from './ola-maps.controller.js'
import { OlaMapsService } from './ola-maps.service.js'
import {
  styleUrlSchema,
  styleJsonSchema,
  geocodeSchema,
  reverseGeocodeSchema,
} from './ola-maps.schema.js'

/**
 * Ola Maps routes plugin — Beta/test module
 * Prefix: /api/v1/maps/ola
 *
 * /style-url, /geocode, /reverse-geocode require authentication (this
 * proxies a paid, quota-limited third-party API — never expose it
 * unauthenticated). /style.json is the one exception: it's the URL
 * /style-url hands back, fetched directly by the native map engine, which
 * can't attach our bearer token — see the note on
 * OlaMapsController#styleJson.
 */
export default async function olaMapsRoutes(fastify) {
  const service = new OlaMapsService()
  const controller = new OlaMapsController(service)

  // GET /style-url — MapLibre style URL for the mobile map widget [AUTH]
  fastify.get('/style-url', {
    schema: styleUrlSchema,
    preHandler: [fastify.authenticate],
  }, controller.getStyleUrl.bind(controller))

  // GET /style.json — rewritten, self-contained style document [PUBLIC]
  fastify.get('/style.json', {
    schema: styleJsonSchema,
  }, controller.styleJson.bind(controller))

  // GET /geocode — forward geocode (address -> coordinates) [AUTH]
  fastify.get('/geocode', {
    schema: geocodeSchema,
    preHandler: [fastify.authenticate],
  }, controller.geocode.bind(controller))

  // GET /reverse-geocode — reverse geocode (coordinates -> address) [AUTH]
  fastify.get('/reverse-geocode', {
    schema: reverseGeocodeSchema,
    preHandler: [fastify.authenticate],
  }, controller.reverseGeocode.bind(controller))
}
