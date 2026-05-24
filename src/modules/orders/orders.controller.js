import { success, error } from '../../utils/apiResponse.js'

/**
 * Orders controller — thin HTTP layer
 */
export class OrdersController {
  constructor(service) {
    this.service = service
  }

  // ─── Customer endpoints ─────────────────────────────────

  async placeOrder(request, reply) {
    const result = await this.service.placeOrder(request.user.id, request.body)
    if (!result.success) {
      const code = result.code || 'ORDER_FAILED'
      const payload = error(result.message, code)
      if (Array.isArray(result.failures) && result.failures.length > 0) {
        payload.failures = result.failures
      }
      return reply.code(400).send(payload)
    }
    // Multi-vendor: return the full per-shop order list, keep `order` for
    // backwards compatibility with single-shop clients.
    const data = {
      orders: result.orders || [result.order],
      order: result.order,
    }
    return reply.code(201).send(success(data, 'Order placed successfully'))
  }

  async list(request, reply) {
    const { orders, pagination } = await this.service.listByUser(
      request.user.id,
      request.query
    )
    return reply.send(success(orders, 'Orders fetched', { pagination }))
  }

  async getActive(request, reply) {
    const order = await this.service.getActive(request.user.id)
    if (!order) {
      return reply.code(404).send(error('No active order', 'NOT_FOUND'))
    }
    return reply.send(success(order, 'Active order fetched'))
  }

  async getById(request, reply) {
    const order = await this.service.getById(request.user.id, request.params.id)
    if (!order) {
      return reply.code(404).send(error('Order not found', 'NOT_FOUND'))
    }
    return reply.send(success(order, 'Order fetched'))
  }

  async cancel(request, reply) {
    const result = await this.service.cancel(
      request.user.id,
      request.params.id,
      request.body?.reason
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'CANCEL_FAILED'))
    }
    return reply.send(success(result.order, 'Order cancelled'))
  }

  async reorder(request, reply) {
    const result = await this.service.reorder(request.user.id, request.params.id)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'REORDER_FAILED'))
    }
    return reply.send(success(result.cart, 'Items added to cart', {
      warnings: result.warnings,
    }))
  }

  // ─── Admin endpoints ────────────────────────────────────

  async adminList(request, reply) {
    const { orders, pagination } = await this.service.adminListAll(request.query)
    return reply.send(success(orders, 'Orders fetched', { pagination }))
  }

  async adminUpdateStatus(request, reply) {
    const result = await this.service.adminUpdateStatus(
      request.params.id,
      request.body.status
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'UPDATE_FAILED'))
    }
    return reply.send(success(result.order, 'Order status updated'))
  }

  async adminAssignRider(request, reply) {
    const result = await this.service.adminAssignRider(
      request.params.id,
      request.body.riderId
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'ASSIGN_FAILED'))
    }
    return reply.send(success(result.order, 'Rider assigned'))
  }

  // ─── Invoice ────────────────────────────────────────────

  async getInvoice(request, reply) {
    const result = await this.service.getInvoice(request.user.id, request.params.id)
    if (!result.success) {
      return reply.code(result.statusCode || 400).send(error(result.message, 'INVOICE_FAILED'))
    }
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename=invoice-${result.orderNumber}.pdf`)
    return reply.send(result.buffer)
  }
}
