import { success, error } from '../../../utils/apiResponse.js'

export class AdminLedgerController {
  constructor(service) {
    this.service = service
  }

  async findAll(request, reply) {
    const data = await this.service.findAll(request.query)
    return reply.send(success(data, 'Ledger accounts fetched'))
  }

  async findById(request, reply) {
    try {
      const data = await this.service.findById(request.params.id)
      return reply.send(success(data, 'Ledger account detail'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async setup(request, reply) {
    try {
      const data = await this.service.setup(
        request.params.businessAccountId,
        request.body,
        request.user.id,
        request.ip
      )
      return reply.code(201).send(success(data, 'Ledger account set up'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async updateLimits(request, reply) {
    try {
      const data = await this.service.updateLimits(request.params.id, request.body, request.user.id, request.ip)
      return reply.send(success(data, 'Ledger limits updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async setStatus(request, reply) {
    try {
      const data = await this.service.setStatus(request.params.id, request.body.status, request.user.id, request.ip)
      return reply.send(success(data, 'Ledger status updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async repay(request, reply) {
    try {
      const data = await this.service.adminRepay(
        request.params.id,
        request.body.amount,
        request.body.description,
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Repayment recorded'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getCycles(request, reply) {
    try {
      const page = parseInt(request.query.page, 10) || 1
      const limit = Math.min(parseInt(request.query.limit, 10) || 20, 100)
      const result = await this.service.getCycles(request.params.id, { page, limit })
      return reply.send(success(result.cycles, 'Billing cycles fetched', { pagination: result.pagination }))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async markCyclePaid(request, reply) {
    try {
      const data = await this.service.markCyclePaid(
        request.params.cycleId,
        request.body,
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Billing cycle marked as paid'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }
}
