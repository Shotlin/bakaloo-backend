import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CouponsController } from '../../../src/modules/coupons/coupons.controller.js'

// ─── Test Helpers ────────────────────────────────────────
function createServiceMock() {
  return {
    validate: vi.fn(),
    getAvailable: vi.fn(),
  }
}

function createCartServiceMock(cart) {
  return {
    getCart: vi.fn().mockResolvedValue(cart),
  }
}

/**
 * Build a Fastify-style reply mock with chainable .code().send()
 */
function createReplyMock() {
  const reply = {
    statusCode: 200,
    body: undefined,
    code: vi.fn(function (status) {
      this.statusCode = status
      return this
    }),
    send: vi.fn(function (payload) {
      this.body = payload
      return this
    }),
  }
  return reply
}

const USER_ID = '11111111-1111-1111-1111-111111111111'

// ═══════════════════════════════════════════════════════════
// CouponsController.validate() — server-authoritative cartTotal
//
// Reported bug: the /validate endpoint fetched the customer's real
// server-side cart (to filter down to fulfillable items for
// category/product-scoped coupons) but then threw away its authoritative
// subtotal and validated against request.body.cartTotal instead — a number
// supplied entirely by the client. Whenever the app's locally-cached total
// drifted from the server's real one (stale cart screen, a sale price that
// changed, an item that just went out of stock), the coupon could show as
// valid (or invalid, or with a different discount) here yet behave
// differently a moment later at actual order placement — which always uses
// the server's own subtotal (orders.service.js never trusts client input
// for this). Same coupon, same real cart, inconsistent outcome.
// ═══════════════════════════════════════════════════════════
describe('CouponsController.validate() — uses the server-computed cart subtotal, not the client-supplied one', () => {
  let service
  let cartService
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    reply = createReplyMock()
  })

  it('passes cart.subtotal (authoritative) to service.validate, ignoring request.body.cartTotal entirely', async () => {
    const cart = {
      subtotal: 250,
      items: [
        { productId: 'p1', isAvailable: true, stockQuantity: 5, quantity: 1 },
      ],
    }
    service = createServiceMock()
    service.validate.mockResolvedValue({ valid: true, discount: 25, code: 'SAVE25' })
    cartService = createCartServiceMock(cart)
    controller = new CouponsController(service, cartService)

    // Client claims a much larger cart total than the server actually has
    // on record (stale local total) — the fix must ignore this value.
    const request = {
      user: { id: USER_ID },
      body: { code: 'SAVE25', cartTotal: 999999 },
    }

    await controller.validate(request, reply)

    expect(service.validate).toHaveBeenCalledTimes(1)
    const [userId, code, cartTotalArg] = service.validate.mock.calls[0]
    expect(userId).toBe(USER_ID)
    expect(code).toBe('SAVE25')
    expect(cartTotalArg).toBe(250)
    expect(cartTotalArg).not.toBe(999999)
  })

  it('still filters to only fulfillable (available + in-stock) cart items for scope matching', async () => {
    const cart = {
      subtotal: 100,
      items: [
        { productId: 'p1', isAvailable: true, stockQuantity: 5, quantity: 1 },
        { productId: 'p2', isAvailable: false, stockQuantity: 0, quantity: 1 },
        { productId: 'p3', isAvailable: true, stockQuantity: 1, quantity: 3 },
      ],
    }
    service = createServiceMock()
    service.validate.mockResolvedValue({ valid: true, discount: 10, code: 'DAIRY10' })
    cartService = createCartServiceMock(cart)
    controller = new CouponsController(service, cartService)

    const request = {
      user: { id: USER_ID },
      body: { code: 'DAIRY10', cartTotal: 100 },
    }

    await controller.validate(request, reply)

    const [, , , cartItemsArg] = service.validate.mock.calls[0]
    expect(cartItemsArg).toHaveLength(1)
    expect(cartItemsArg[0].productId).toBe('p1')
  })

  it('returns 400 with the service error code when the coupon is invalid against the real cart total', async () => {
    const cart = { subtotal: 40, items: [] }
    service = createServiceMock()
    service.validate.mockResolvedValue({
      valid: false,
      message: 'Minimum order amount is ₹100',
      code: 'COUPON_MIN_ORDER_NOT_MET',
    })
    cartService = createCartServiceMock(cart)
    controller = new CouponsController(service, cartService)

    // Client-side total claims the minimum is met — the server's real
    // (lower) total must be what actually gets validated.
    const request = {
      user: { id: USER_ID },
      body: { code: 'SAVE25', cartTotal: 500 },
    }

    await controller.validate(request, reply)

    expect(service.validate.mock.calls[0][2]).toBe(40)
    expect(reply.statusCode).toBe(400)
    expect(reply.body.code).toBe('COUPON_MIN_ORDER_NOT_MET')
  })
})
