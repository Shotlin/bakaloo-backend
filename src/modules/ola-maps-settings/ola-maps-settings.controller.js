import { success } from '../../utils/apiResponse.js'

/**
 * Ola Maps settings controller — thin HTTP layer
 */
export class OlaMapsSettingsController {
  constructor(service) {
    this.service = service
  }

  /** GET / — current settings (masked key) */
  async get(request, reply) {
    const settings = await this.service.get()
    return reply.code(200).send(success(settings, 'Ola Maps settings fetched'))
  }

  /** POST /test — validate a key live, without saving it */
  async test(request, reply) {
    const result = await this.service.test(request.body.apiKey)
    const message = result.success ? 'Connection successful' : 'Connection failed'
    return reply.code(200).send(success(result, message))
  }

  /** PUT / — save settings (re-tests live when the key changes) */
  async save(request, reply) {
    const { apiKey, isEnabled } = request.body
    const result = await this.service.save({ apiKey, isEnabled }, request.user?.id)
    const message = result.test && !result.test.success
      ? 'Saved, but the connection test failed — Ola Maps stays disabled until a working key is saved'
      : 'Ola Maps settings saved'
    return reply.code(200).send(success(result, message))
  }
}
