import { success } from '../../utils/apiResponse.js'

/**
 * Ola Maps controller — thin HTTP layer
 */
export class OlaMapsController {
  constructor(service) {
    this.service = service
  }

  /** GET /style-url [AUTH] */
  async getStyleUrl(request, reply) {
    const publicBaseUrl = `${request.protocol}://${request.hostname}`
    const { configured, styleUrl } = await this.service.getStyleInfo(publicBaseUrl)
    return reply.code(200).send(success({ configured, styleUrl }))
  }

  /**
   * GET /style.json [PUBLIC] — the URL getStyleUrl hands back. No app auth:
   * the native map engine that fetches this can't attach our bearer token,
   * same constraint every client-embedded map key lives with. Returns the
   * raw MapLibre style document, not the {success,data} envelope — this is
   * fetched directly by MapLibreMap's native styleString loader.
   */
  async styleJson(request, reply) {
    const style = await this.service.buildProxiedStyle(request.query.style)
    if (!style) {
      return reply.code(503).send({ error: 'Ola Maps style unavailable' })
    }
    return reply.code(200).send(style)
  }

  /** GET /geocode */
  async geocode(request, reply) {
    const configured = await this.service.isConfigured()
    const result = configured ? await this.service.geocode(request.query.address) : null
    return reply.code(200).send(success({ configured, result }))
  }

  /** GET /reverse-geocode */
  async reverseGeocode(request, reply) {
    const { lat, lng } = request.query
    const configured = await this.service.isConfigured()
    const result = configured ? await this.service.reverseGeocode(lat, lng) : null
    return reply.code(200).send(success({ configured, result }))
  }

  /** GET /directions */
  async directions(request, reply) {
    const { originLat, originLng, destLat, destLng } = request.query
    const configured = await this.service.isConfigured()
    const result = configured
      ? await this.service.directions(originLat, originLng, destLat, destLng)
      : null
    return reply.code(200).send(success({ configured, result }))
  }
}
