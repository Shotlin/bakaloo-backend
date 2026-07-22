import { success, error } from '../../utils/apiResponse.js'

export class PurchaseLimitsController {
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

  /** GET /my-status?productIds=a,b,c — customer-facing, powers the "+" button */
  async myStatus(request, reply) {
    const raw = request.query.productIds || ''
    const productIds = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (productIds.length === 0) {
      return reply.code(200).send(success({ items: [] }, 'No products requested'))
    }
    const items = await this.service.getStatusForUser(request.user.id, productIds)
    return reply.code(200).send(success({ items }, 'Purchase limit status fetched'))
  }

  /** GET / — Admin */
  async list(request, reply) {
    const rules = await this.service.listAll()
    return reply.code(200).send(success(rules, 'Purchase limit rules fetched'))
  }

  /** POST / — Admin */
  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.rule, 'Purchase limit rule created'))
  }

  /** PATCH /:id — Admin */
  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      const status = result.message === 'Rule not found' ? 404 : 400
      return reply.code(status).send(error(result.message, status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.rule, 'Purchase limit rule updated'))
  }

  /** PATCH /:id/toggle — Admin */
  async toggle(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.toggleActive(request.params.id, request.body.isActive, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.rule, 'Purchase limit rule updated'))
  }

  /** DELETE /:id — Admin */
  async remove(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.remove(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Purchase limit rule deleted'))
  }
}
