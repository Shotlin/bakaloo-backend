import { success, error } from '../../../utils/apiResponse.js'

export class AreaSegmentsController {
  constructor(service) {
    this.service = service
  }

  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      platformRole: request.user?.platform_role ?? request.user?.platformRole ?? null,
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  async list(request, reply) {
    const segments = await this.service.list()
    return reply.code(200).send(success(segments, 'Area segments fetched'))
  }

  async getDetail(request, reply) {
    const segment = await this.service.getDetail(request.params.id)
    if (!segment) {
      return reply.code(404).send(error('Segment not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(segment, 'Area segment fetched'))
  }

  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.segment, 'Area segment created'))
  }

  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.segment, 'Area segment updated'))
  }

  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Area segment deleted'))
  }

  async getAddresses(request, reply) {
    const { page, limit } = request.query
    const data = await this.service.getAddresses(request.params.id, { page, limit })
    return reply.code(200).send(success(data.addresses, 'Segment addresses fetched', { pagination: data.pagination }))
  }

  async addAddress(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.addAddress(request.params.id, request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success({ added: result.added, conflicts: result.conflicts }, 'Address added to segment'))
  }

  async removeAddress(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.removeAddress(request.params.id, request.params.addressId, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Address removed from segment'))
  }

  async getActiveOrders(request, reply) {
    const orders = await this.service.getActiveOrders(request.params.id)
    return reply.code(200).send(success(orders, 'Active orders for segment fetched'))
  }

  async searchCandidates(request, reply) {
    const candidates = await this.service.searchCandidates(request.query.q, { limit: request.query.limit })
    return reply.code(200).send(success(candidates, 'Candidates fetched'))
  }

  async getCustomerAddresses(request, reply) {
    const addresses = await this.service.getCustomerAddresses(request.params.userId)
    return reply.code(200).send(success(addresses, 'Customer addresses fetched'))
  }
}
