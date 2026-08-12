import { Gstr1Controller } from './gstr1.controller.js'
import { Gstr1Service } from './gstr1.service.js'

/**
 * GSTR-1 routes — business-wide (single GSTIN) B2CS + HSN Summary reporting.
 * Prefix: /api/v1/admin/gstr1
 *
 * Not shop-scoped (unlike admin/analytics) — this is deliberately one
 * report across the whole business, matching the single filed GSTIN
 * (STORE_INFO.gstNo). All routes require a valid JWT + ADMIN role, same
 * guard as admin/finance.
 */
export default async function gstr1Routes(fastify) {
  const service = new Gstr1Service()
  const controller = new Gstr1Controller(service)

  const requireGlobalView = async function (request, reply) {
    const role = request.user?.role
    if (role === 'ADMIN') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — finance.global_view permission required',
      code: 'FORBIDDEN',
    })
  }

  const readPreHandlers = [fastify.authenticate, requireGlobalView]

  fastify.get('/period', {
    schema: {
      tags: ['Admin GSTR-1'],
      summary: 'Resolve a GSTR-1 period to its date range + due date [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.getPeriod.bind(controller))

  fastify.get('/b2cs', {
    schema: {
      tags: ['Admin GSTR-1'],
      summary: 'B2CS (B2C Small) state+rate-wise summary [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.getB2CS.bind(controller))

  fastify.get('/hsn-summary', {
    schema: {
      tags: ['Admin GSTR-1'],
      summary: 'HSN Summary [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.getHsnSummary.bind(controller))

  fastify.get('/export-excel', {
    schema: {
      tags: ['Admin GSTR-1'],
      summary: 'B2CS + HSN Summary Excel export, matching the GSTR-1 offline utility format [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.exportExcel.bind(controller))
}
