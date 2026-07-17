import { AdminOrdersRepository } from './orders.repository.js'
import { AdminOrdersService } from './orders.service.js'
import { AdminOrdersController } from './orders.controller.js'
import {
  listOrdersSchema, statsByStatusSchema, orderDetailSchema,
  updateStatusSchema, assignRiderSchema, bulkAssignSchema,
  manualOrderSchema, invoiceSchema, packingSlipSchema, exportSchema,
  refundOrderSchema, cancelOrderSchema, bulkStatusSchema,
  rescheduleOrderSchema, orderNotesListSchema, addOrderNoteSchema,
} from './orders.schema.js'

/**
 * Admin orders routes
 * Prefix: /api/v1/admin/orders
 */
export default async function adminOrdersRoutes(fastify) {
  const repo = new AdminOrdersRepository()
  const service = new AdminOrdersService(repo, fastify)
  const ctrl = new AdminOrdersController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listOrdersSchema, preHandler: adminAuth }, ctrl.findAll.bind(ctrl))
  fastify.get('/stats-by-status', { schema: statsByStatusSchema, preHandler: adminAuth }, ctrl.getStatsByStatus.bind(ctrl))
  fastify.get('/export', { schema: exportSchema, preHandler: adminAuth }, ctrl.exportCSV.bind(ctrl))
  fastify.post('/manual', { schema: manualOrderSchema, preHandler: adminAuth }, ctrl.createManualOrder.bind(ctrl))
  fastify.post('/bulk-assign', { schema: bulkAssignSchema, preHandler: adminAuth }, ctrl.bulkAssign.bind(ctrl))
  fastify.get('/:id', { schema: orderDetailSchema, preHandler: adminAuth }, ctrl.findById.bind(ctrl))
  fastify.get('/:id/notes', { schema: orderNotesListSchema, preHandler: adminAuth }, ctrl.getOrderNotes.bind(ctrl))
  fastify.post('/:id/notes', { schema: addOrderNoteSchema, preHandler: adminAuth }, ctrl.addOrderNote.bind(ctrl))
  fastify.put('/:id/status', { schema: updateStatusSchema, preHandler: adminAuth }, ctrl.updateStatus.bind(ctrl))
  fastify.put('/:id/reschedule', { schema: rescheduleOrderSchema, preHandler: adminAuth }, ctrl.rescheduleDelivery.bind(ctrl))
  fastify.put('/:id/assign-rider', { schema: assignRiderSchema, preHandler: adminAuth }, ctrl.assignRider.bind(ctrl))
  fastify.get('/:id/invoice', { schema: invoiceSchema, preHandler: adminAuth }, ctrl.getInvoice.bind(ctrl))
  fastify.get('/:id/packing-slip', { schema: packingSlipSchema, preHandler: adminAuth }, ctrl.getPackingSlip.bind(ctrl))
  fastify.post('/:id/refund', { schema: refundOrderSchema, preHandler: adminAuth }, ctrl.refundOrder.bind(ctrl))
  fastify.post('/:id/cancel', { schema: cancelOrderSchema, preHandler: adminAuth }, ctrl.cancelOrder.bind(ctrl))
  fastify.post('/bulk-status', { schema: bulkStatusSchema, preHandler: adminAuth }, ctrl.bulkUpdateStatus.bind(ctrl))
}
