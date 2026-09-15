import { success, error } from '../../utils/apiResponse.js'

export class ScratchCardController {
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

  // ─── Customer ───────────────────────────────────────────

  /** GET /appearance */
  async appearance(request, reply) {
    const data = await this.service.getAppearanceForCustomer()
    return reply.code(200).send(success(data, 'Scratch card appearance fetched'))
  }

  /** GET /eligibility */
  async eligibility(request, reply) {
    const data = await this.service.getEligibility(request.user.id)
    return reply.code(200).send(success(data, 'Scratch eligibility fetched'))
  }

  /** POST /scratch */
  async scratch(request, reply) {
    const result = await this.service.scratch(request.user.id)
    if (!result.success) {
      return reply.code(200).send(success(result, result.message))
    }
    return reply.code(200).send(success(result, 'Scratch resolved'))
  }

  // ─── Admin: prizes ──────────────────────────────────────

  async listPrizes(request, reply) {
    const prizes = await this.service.listPrizes()
    return reply.code(200).send(success(prizes, 'Scratch prizes fetched'))
  }

  async createPrize(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.createPrize(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.prize, 'Scratch prize created'))
  }

  async updatePrize(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.updatePrize(request.params.id, request.body, actor)
    if (!result.success) {
      const code = result.message === 'Prize not found' ? 404 : 400
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.prize, 'Scratch prize updated'))
  }

  async deletePrize(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.deletePrize(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Scratch prize deleted'))
  }

  async reorderPrizes(request, reply) {
    const actor = this._actorCtx(request)
    await this.service.reorderPrizes(request.body.orderedIds, actor)
    return reply.code(200).send(success(null, 'Scratch prizes reordered'))
  }

  // ─── Admin: first-time reward prizes ─────────────────────

  async listFirstTimePrizes(request, reply) {
    const prizes = await this.service.listFirstTimePrizes()
    return reply.code(200).send(success(prizes, 'First-time scratch prizes fetched'))
  }

  async createFirstTimePrize(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.createFirstTimePrize(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.prize, 'First-time scratch prize created'))
  }

  async updateFirstTimePrize(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.updateFirstTimePrize(request.params.id, request.body, actor)
    if (!result.success) {
      const code = result.message === 'Prize not found' ? 404 : 400
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.prize, 'First-time scratch prize updated'))
  }

  async deleteFirstTimePrize(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.deleteFirstTimePrize(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'First-time scratch prize deleted'))
  }

  async reorderFirstTimePrizes(request, reply) {
    const actor = this._actorCtx(request)
    await this.service.reorderFirstTimePrizes(request.body.orderedIds, actor)
    return reply.code(200).send(success(null, 'First-time scratch prizes reordered'))
  }

  // ─── Admin: settings ────────────────────────────────────

  async getSettings(request, reply) {
    const settings = await this.service.getSettings()
    return reply.code(200).send(success(settings, 'Scratch card settings fetched'))
  }

  async updateSettings(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.updateSettings(request.body, actor)
    return reply.code(200).send(success(result.settings, 'Scratch card settings updated'))
  }

  // ─── Admin: milestone rules ──────────────────────────────

  async listMilestoneRules(request, reply) {
    const rules = await this.service.listMilestoneRules()
    return reply.code(200).send(success(rules, 'Scratch milestone rules fetched'))
  }

  async createMilestoneRule(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.createMilestoneRule(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.rule, 'Scratch milestone rule created'))
  }

  async updateMilestoneRule(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.updateMilestoneRule(request.params.id, request.body, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.rule, 'Scratch milestone rule updated'))
  }

  async deleteMilestoneRule(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.deleteMilestoneRule(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Scratch milestone rule deleted'))
  }

  // ─── Admin: manual grant + history ───────────────────────

  async grantScratches(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.grantScratches(request.body.userId, request.body.amount, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result, 'Scratch cards granted'))
  }

  async listHistory(request, reply) {
    const { limit, offset, userId } = request.query
    const data = await this.service.listHistory({
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
      userId: userId || null,
    })
    return reply.code(200).send(success(data, 'Scratch history fetched'))
  }
}
