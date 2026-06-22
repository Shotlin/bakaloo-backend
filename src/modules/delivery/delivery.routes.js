import { DeliveryController } from './delivery.controller.js'
import { DeliveryService } from './delivery.service.js'
import { DeliveryRepository } from './delivery.repository.js'
import {
  getAssignedOrdersSchema,
  acceptOrderSchema,
  resendOtpSchema,
  cancelDeliverySchema,
  rejectOrderSchema,
  markPickedUpSchema,
  markDeliveredSchema,
  uploadProofSchema,
  getStatsSchema,
  getEarningsSchema,
  getPayoutsSchema,
  updateLocationSchema,
  toggleOnlineSchema,
  getProfileSchema,
  getHistorySchema,
  getDocumentsSchema,
  uploadDocumentSchema,
} from './delivery.schema.js'

/**
 * Delivery routes plugin
 * Prefix: /api/v1/delivery
 * Requires DELIVERY role
 */
export default async function deliveryRoutes(fastify) {
  const repository = new DeliveryRepository()
  const service = new DeliveryService(repository, fastify)
  const controller = new DeliveryController(service)

  // All routes require authentication
  fastify.addHook('preHandler', fastify.authenticate)

  // GET /profile — Rider profile
  fastify.get('/profile', {
    schema: getProfileSchema,
  }, controller.getProfile.bind(controller))

  // GET /documents — Get rider documents
  fastify.get('/documents', {
    schema: getDocumentsSchema,
  }, controller.getDocuments.bind(controller))

  // POST /documents/:type — Upload specific document type
  fastify.post('/documents/:type', {
    schema: uploadDocumentSchema,
  }, controller.uploadDocument.bind(controller))

  // POST /documents — Upload document via form data
  fastify.post('/documents', {
    schema: uploadDocumentSchema,
  }, controller.uploadDocument.bind(controller))

  // PATCH /toggle-online — Go online/offline
  fastify.patch('/toggle-online', {
    schema: toggleOnlineSchema,
  }, controller.toggleOnline.bind(controller))

  // GET /orders — Get assigned orders
  fastify.get('/orders', {
    schema: getAssignedOrdersSchema,
  }, controller.getAssignedOrders.bind(controller))

  // PATCH /orders/:id/accept — Accept order
  fastify.patch('/orders/:id/accept', {
    schema: acceptOrderSchema,
  }, controller.acceptOrder.bind(controller))

  // PATCH /orders/:id/reject — Reject order
  fastify.patch('/orders/:id/reject', {
    schema: rejectOrderSchema,
  }, controller.rejectOrder.bind(controller))

  // PATCH /orders/:id/resend-otp — Regenerate and re-notify delivery OTP
  fastify.patch('/orders/:id/resend-otp', {
    schema: resendOtpSchema,
  }, controller.resendOtp.bind(controller))

  // PATCH /orders/:id/cancel — Cancel an accepted/in-transit delivery
  fastify.patch('/orders/:id/cancel', {
    schema: cancelDeliverySchema,
  }, controller.cancelDelivery.bind(controller))

  // PATCH /orders/:id/pickup — Mark picked up
  fastify.patch('/orders/:id/pickup', {
    schema: markPickedUpSchema,
  }, controller.markPickedUp.bind(controller))

  // PATCH /orders/:id/deliver — Mark delivered
  fastify.patch('/orders/:id/deliver', {
    schema: markDeliveredSchema,
  }, controller.markDelivered.bind(controller))

  // POST /orders/:id/proof — Upload delivery proof photo
  fastify.post('/orders/:id/proof', {
    schema: uploadProofSchema,
  }, controller.uploadProof.bind(controller))

  // GET /stats — Get stats
  fastify.get('/stats', {
    schema: getStatsSchema,
  }, controller.getStats.bind(controller))

  // GET /earnings — Get rider earnings summary
  fastify.get('/earnings', {
    schema: getEarningsSchema,
  }, controller.getEarnings.bind(controller))

  // GET /payouts — Get rider payout history
  fastify.get('/payouts', {
    schema: getPayoutsSchema,
  }, controller.getPayouts.bind(controller))

  // PATCH /location — Update location
  fastify.patch('/location', {
    schema: updateLocationSchema,
  }, controller.updateLocation.bind(controller))

  // GET /history — Delivery history
  fastify.get('/history', {
    schema: getHistorySchema,
  }, controller.getHistory.bind(controller))

  // GET /store-info — Store location for map
  fastify.get('/store-info', controller.getStoreInfo.bind(controller))
}
