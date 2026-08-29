import { PaymentsController } from './payments.controller.js'
import { PaymentsService } from './payments.service.js'
import { PaymentsRepository } from './payments.repository.js'
import {
  createPaymentOrderSchema,
  verifyPaymentSchema,
  paymentStatusSchema,
  paymentHistorySchema,
  refundSchema,
} from './payments.schema.js'

/**
 * Payments routes plugin
 * Prefix: /api/v1/payments
 */
export default async function paymentsRoutes(fastify) {
  const repository = new PaymentsRepository()
  const service = new PaymentsService(repository, fastify)
  const controller = new PaymentsController(service)

  // ─── Customer routes (AUTH) ─────────────────────────────

  // POST /create-order — Create Razorpay payment order
  fastify.post('/create-order', {
    schema: createPaymentOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.createPaymentOrder.bind(controller))

  // POST /verify — Verify payment signature
  fastify.post('/verify', {
    schema: verifyPaymentSchema,
    preHandler: [fastify.authenticate],
  }, controller.verifyPayment.bind(controller))

  // GET /history — Payment history
  fastify.get('/history', {
    schema: paymentHistorySchema,
    preHandler: [fastify.authenticate],
  }, controller.history.bind(controller))

  // GET /status/:razorpayOrderId — poll current status after an ambiguous
  // checkout result (Razorpay SDK error that isn't a genuine cancellation)
  fastify.get('/status/:razorpayOrderId', {
    schema: paymentStatusSchema,
    preHandler: [fastify.authenticate],
  }, controller.status.bind(controller))

  // ─── Webhook (NO AUTH — verified by Razorpay signature) ────────────

  // POST /webhook — Razorpay event webhook
  // Raw body must be preserved for signature verification. rateLimit:
  // false for defensive symmetry with the /api/webhook/razorpay
  // registration in app.js (Razorpay retries failed webhook deliveries —
  // this endpoint must never silently rate-limit a legitimate retry).
  // Not currently reachable in practice (global rate limiting is off), but
  // kept explicit so it stays true if that ever changes.
  fastify.post('/webhook', {
    config: { rawBody: true, rateLimit: false },
    schema: {
      body: { type: 'object', additionalProperties: true },
    },
  }, controller.webhook.bind(controller))

  // ─── Admin routes ───────────────────────────────────────

  // POST /:id/refund — Initiate refund [ADMIN]
  fastify.post('/:id/refund', {
    schema: refundSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.refund.bind(controller))
}
