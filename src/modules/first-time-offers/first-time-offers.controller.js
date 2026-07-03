import { success, error } from '../../utils/apiResponse.js'

export class FirstTimeOffersController {
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

  /** GET /eligible?cartTotal= — customer-facing preview */
  async eligible(request, reply) {
    const cartTotal = Number(request.query.cartTotal || 0)
    const offer = await this.service.resolveForCheckout(request.user.id, cartTotal)
    if (!offer) {
      return reply.code(200).send(success(null, 'No first-time offer available'))
    }
    const reward = this.service.computeReward(offer, cartTotal)
    return reply.code(200).send(success({ offer, reward }, 'First-time offer available'))
  }

  /** GET / — Admin */
  async listAll(request, reply) {
    const offers = await this.service.listAll()
    return reply.code(200).send(success(offers, 'First-time offers fetched'))
  }

  /** POST / — Admin */
  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.offer, 'First-time offer created'))
  }

  /** PATCH /:id — Admin */
  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.offer, 'First-time offer updated'))
  }

  /** DELETE /:id — Admin */
  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'First-time offer deleted'))
  }
}
