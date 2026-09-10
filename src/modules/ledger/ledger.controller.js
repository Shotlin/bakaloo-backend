import { success, error } from '../../utils/apiResponse.js'

/**
 * Ledger controller — customer-facing thin HTTP layer. Read-only: a
 * customer views their own balance/transactions but never draws/repays
 * directly — that happens through checkout (bulk-orders/orders, a later
 * phase) or admin action.
 */
export class LedgerController {
  constructor(service) {
    this.service = service
  }

  /** GET /me */
  async getMine(request, reply) {
    const account = await this.service.getMine(request.user.id)
    if (!account) {
      return reply.code(404).send(error('No ledger account found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(account, 'Ledger account fetched'))
  }

  /** GET /me/transactions */
  async getMyTransactions(request, reply) {
    try {
      const page = parseInt(request.query.page, 10) || 1
      const limit = Math.min(parseInt(request.query.limit, 10) || 20, 100)
      const result = await this.service.getMyTransactions(request.user.id, { page, limit })
      return reply.code(200).send(
        success(result.transactions, 'Ledger transactions fetched', { pagination: result.pagination })
      )
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  /** GET /me/cycles */
  async getMyCycles(request, reply) {
    try {
      const page = parseInt(request.query.page, 10) || 1
      const limit = Math.min(parseInt(request.query.limit, 10) || 20, 100)
      const result = await this.service.getMyCycles(request.user.id, { page, limit })
      return reply.code(200).send(
        success(result.cycles, 'Ledger billing cycles fetched', { pagination: result.pagination })
      )
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  /** POST /pay — Pay for an order from the B2B credit line */
  async payFromLedger(request, reply) {
    const result = await this.service.payFromLedger(request.user.id, request.body.orderId)
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'LEDGER_PAY_FAILED'))
    }
    return reply.send(
      success({ ledgerAccount: result.account, transaction: result.transaction }, 'Payment successful')
    )
  }
}
