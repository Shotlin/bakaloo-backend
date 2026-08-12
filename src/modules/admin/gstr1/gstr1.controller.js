import { success, error } from '../../../utils/apiResponse.js'
import { periodQuerySchema } from './schema.js'

/**
 * GSTR-1 controller — B2CS + HSN Summary reporting.
 * Request/response handling only; delegates to service.
 */
export class Gstr1Controller {
  /** @param {import('./gstr1.service.js').Gstr1Service} service */
  constructor(service) {
    this.service = service
  }

  _parseQuery(request, reply) {
    const parsed = periodQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
      return null
    }
    return parsed.data
  }

  /** GET /period */
  async getPeriod(request, reply) {
    const params = this._parseQuery(request, reply)
    if (!params) return
    if (!params.periodType || !params.year) {
      return reply.code(400).send(error('periodType and year are required for /period', 'VALIDATION_ERROR'))
    }
    const result = this.service.getPeriod(params)
    return reply.code(200).send(success(result, 'GSTR-1 period resolved'))
  }

  /** GET /b2cs */
  async getB2CS(request, reply) {
    const params = this._parseQuery(request, reply)
    if (!params) return
    const result = await this.service.getB2CS(params)
    return reply.code(200).send(success(result, 'B2CS summary retrieved'))
  }

  /** GET /hsn-summary */
  async getHsnSummary(request, reply) {
    const params = this._parseQuery(request, reply)
    if (!params) return
    const result = await this.service.getHsnSummary(params)
    return reply.code(200).send(success(result, 'HSN summary retrieved'))
  }

  /** GET /export-excel */
  async exportExcel(request, reply) {
    const params = this._parseQuery(request, reply)
    if (!params) return
    const buffer = await this.service.exportExcel(params)
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="gstr1-${Date.now()}.xlsx"`)
    return reply.send(buffer)
  }
}
