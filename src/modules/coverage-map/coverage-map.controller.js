import { success, error } from '../../utils/apiResponse.js'

export class CoverageMapController {
  constructor(service) {
    this.service = service
  }

  /** GET /:shopId — Admin */
  async getCoverage(request, reply) {
    const result = await this.service.getCoverage(request.params.shopId)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.data, 'Coverage map fetched'))
  }
}
