import { success } from '../../utils/apiResponse.js'

/**
 * Ola Maps controller — thin HTTP layer
 */
export class OlaMapsController {
  constructor(service) {
    this.service = service
  }

  /** GET /style-url */
  async getStyleUrl(request, reply) {
    const { configured, styleUrl } = await this.service.getStyleInfo()
    return reply.code(200).send(success({ configured, styleUrl }))
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
}
