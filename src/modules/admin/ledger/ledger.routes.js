import { LedgerRepository } from '../../ledger/ledger.repository.js'
import { LedgerService } from '../../ledger/ledger.service.js'
import { AdminLedgerController } from './ledger.controller.js'
import {
  listLedgerAccountsSchema, ledgerAccountDetailSchema,
  setupLedgerAccountSchema, updateLedgerLimitsSchema,
  setLedgerStatusSchema, repayLedgerAccountSchema,
  listLedgerCyclesSchema, markLedgerCyclePaidSchema,
} from './ledger.schema.js'

/**
 * Admin ledger routes
 * Prefix: /api/v1/admin/ledger
 */
export default async function adminLedgerRoutes(fastify) {
  const repo = new LedgerRepository()
  const service = new LedgerService(repo)
  const ctrl = new AdminLedgerController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listLedgerAccountsSchema, preHandler: adminAuth }, ctrl.findAll.bind(ctrl))
  fastify.get('/:id', { schema: ledgerAccountDetailSchema, preHandler: adminAuth }, ctrl.findById.bind(ctrl))
  fastify.post('/:businessAccountId/setup', { schema: setupLedgerAccountSchema, preHandler: adminAuth }, ctrl.setup.bind(ctrl))
  fastify.patch('/:id/limits', { schema: updateLedgerLimitsSchema, preHandler: adminAuth }, ctrl.updateLimits.bind(ctrl))
  fastify.patch('/:id/status', { schema: setLedgerStatusSchema, preHandler: adminAuth }, ctrl.setStatus.bind(ctrl))
  fastify.post('/:id/repay', { schema: repayLedgerAccountSchema, preHandler: adminAuth }, ctrl.repay.bind(ctrl))
  fastify.get('/:id/cycles', { schema: listLedgerCyclesSchema, preHandler: adminAuth }, ctrl.getCycles.bind(ctrl))
  fastify.post('/cycles/:cycleId/mark-paid', { schema: markLedgerCyclePaidSchema, preHandler: adminAuth }, ctrl.markCyclePaid.bind(ctrl))
}
