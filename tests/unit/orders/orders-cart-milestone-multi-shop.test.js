import { describe, expect, it, vi } from 'vitest'

// orders.service.js transitively imports config/database.js + bullmq.js
// (pg Pool / BullMQ Queue construction) — mock both so this unit test needs
// no live DB/Redis. Same setup as orders.closed-store-gate.spec.js.
const queryMock = vi.fn().mockResolvedValue({ rows: [] })
const clientQueryMock = vi.fn().mockResolvedValue({ rows: [] })
const releaseMock = vi.fn()
const getClientMock = vi.fn().mockResolvedValue({ query: clientQueryMock, release: releaseMock })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: (...args) => getClientMock(...args),
  closePool: vi.fn(),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
  smsQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn() },
  allocationQueue: { add: vi.fn() },
  settlementQueue: { add: vi.fn() },
  payoutQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
  scheduledOrdersQueue: { add: vi.fn() },
  reportPrecomputeQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OrdersRepository } from '../../../src/modules/orders/orders.repository.js'
import { OrdersService } from '../../../src/modules/orders/orders.service.js'

/**
 * Coverage for the reported bug: a cart milestone shown as "unlocked" in
 * the live cart preview (bill-summary.service.js, which evaluates the
 * WHOLE cart regardless of shop count) silently granted NOTHING at actual
 * checkout whenever the cart happened to split into 2+ shop orders — the
 * entire cart-milestone block in placeOrder() used to be gated behind
 * `groupedByShop.size === 1`, identical to the coupon/first-time-offer
 * restriction.
 *
 * CASHBACK and COUPON_UNLOCK are per-user/per-order side effects with no
 * dependency on the shared single-shop fee slot, so those must now apply
 * on a multi-shop checkout too. DISCOUNT and FREE_DELIVERY genuinely still
 * need that slot (order-splitter.service.js only ever discounts/waives ONE
 * shop's order) and correctly stay single-shop-only — covered by the
 * negative case below.
 */

const USER_ID = 'user-1'
const SHOP_A = 'shop-a'
const SHOP_B = 'shop-b'
const PROD_A = 'prod-a'
const PROD_B = 'prod-b'
const ADDRESS_ID = 'addr-1'
const MILESTONE_ID = 'milestone-1'
const COUPON_ID = 'coupon-1'

function makeTwoShopCartResult() {
  const itemsA = [{ productId: PROD_A, shopId: SHOP_A, quantity: 1, price: 40, lineTotal: 40 }]
  const itemsB = [{ productId: PROD_B, shopId: SHOP_B, quantity: 1, price: 40, lineTotal: 40 }]
  const groupedByShop = new Map([
    [SHOP_A, itemsA],
    [SHOP_B, itemsB],
  ])
  return {
    valid: true,
    items: [...itemsA, ...itemsB],
    subtotal: 80,
    groupedByShop,
    failed: [],
    warnings: [],
  }
}

function makeTwoCreatedOrders() {
  const orders = [
    { id: 'order-a', shopId: SHOP_A, orderNumber: 'A1', status: 'CONFIRMED', totalAmount: 40, createdAt: new Date(), deliveryMode: 'ASAP' },
    { id: 'order-b', shopId: SHOP_B, orderNumber: 'B1', status: 'CONFIRMED', totalAmount: 40, createdAt: new Date(), deliveryMode: 'ASAP' },
  ]
  orders.stockTransitions = []
  orders.routeLookups = []
  return orders
}

function makeService(overrides = {}) {
  const mocks = {
    cartService: {
      validateCart: vi.fn().mockResolvedValue(makeTwoShopCartResult()),
      clearCart: vi.fn().mockResolvedValue(undefined),
    },
    addressesRepository: {
      findByIdAndUser: vi.fn().mockResolvedValue({ id: ADDRESS_ID, lat: 12.9, lng: 77.6, pincode: '560001' }),
    },
    allocationRepository: {
      isServiceable: vi.fn().mockResolvedValue(true),
    },
    paymentSettingsService: {
      getConfig: vi.fn().mockResolvedValue({
        codEnabled: true, codMinOrderAmount: 0, codMaxOrderAmount: null,
        razorpayEnabled: true, walletEnabled: true,
      }),
    },
    billSummaryService: {
      getBillSummary: vi.fn().mockResolvedValue({ totalPayable: 80 }),
    },
    couponsService: {
      validate: vi.fn(),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    },
    couponsRepository: {
      addTargetUser: vi.fn().mockResolvedValue(undefined),
    },
    firstTimeOffersService: {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
    },
    cartMilestonesService: {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
      computeReward: vi.fn(),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    },
    paymentOffersService: {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
    },
    cashbackService: {
      createPending: vi.fn().mockResolvedValue(undefined),
      evaluateAndCredit: vi.fn().mockResolvedValue(undefined),
    },
    orderSplitter: {
      splitCart: vi.fn().mockReturnValue([]),
      createOrders: vi.fn().mockResolvedValue(makeTwoCreatedOrders()),
      firePostCommitSideEffects: vi.fn().mockResolvedValue(undefined),
    },
    storeStatusService: { isOpen: vi.fn().mockResolvedValue({ isOpen: true }) },
    deliveryCalendarService: { getMaxGeneratedDate: vi.fn().mockResolvedValue(null) },
    abandonedCartsRepository: { markConvertedByUserId: vi.fn().mockResolvedValue(undefined) },
    cartRepository: {
      getTip: vi.fn().mockResolvedValue(0),
      getInstructions: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  }

  const service = new OrdersService(new OrdersRepository(), null, mocks)
  return { service, ...mocks }
}

describe('OrdersService.placeOrder — cart milestone on a multi-shop cart (positive)', () => {
  it('unlocks a COUPON_UNLOCK-reward milestone, resolved against the whole cart, not gated to a single shop', async () => {
    const milestone = {
      id: MILESTONE_ID,
      rewardType: 'COUPON_UNLOCK',
      unlockCouponId: COUPON_ID,
      stackableWithCoupon: true,
      cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const { service, cartMilestonesService, couponsRepository } = makeService()
    cartMilestonesService.resolveForCheckout.mockResolvedValue(milestone)
    cartMilestonesService.computeReward.mockReturnValue({ unlockCouponId: COUPON_ID, freeDelivery: false })

    const result = await service.placeOrder(USER_ID, { addressId: ADDRESS_ID, paymentMethod: 'COD' })

    expect(result.success).toBe(true)
    // Resolved against the WHOLE cart (both shops' items, aggregate
    // subtotal) — the exact same total/items the live cart preview used.
    expect(cartMilestonesService.resolveForCheckout).toHaveBeenCalledWith(
      USER_ID,
      80,
      expect.arrayContaining([
        expect.objectContaining({ productId: PROD_A }),
        expect.objectContaining({ productId: PROD_B }),
      ])
    )
    expect(couponsRepository.addTargetUser).toHaveBeenCalledWith(COUPON_ID, USER_ID)
    expect(cartMilestonesService.recordUsage).toHaveBeenCalledWith(MILESTONE_ID, USER_ID, expect.any(String))
  })

  it('still credits cashback on a multi-shop cart milestone', async () => {
    const milestone = {
      id: MILESTONE_ID,
      rewardType: 'CASHBACK',
      stackableWithCoupon: true,
      cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const { service, cartMilestonesService, cashbackService } = makeService()
    cartMilestonesService.resolveForCheckout.mockResolvedValue(milestone)
    cartMilestonesService.computeReward.mockReturnValue({ cashbackAmount: 15, freeDelivery: false })

    const result = await service.placeOrder(USER_ID, { addressId: ADDRESS_ID, paymentMethod: 'COD' })

    expect(result.success).toBe(true)
    expect(cashbackService.createPending).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'CART_MILESTONE', sourceId: MILESTONE_ID, amount: 15 })
    )
  })
})

describe('OrdersService.placeOrder — cart milestone on a multi-shop cart (negative — discount/free-delivery still need the single-shop fee slot)', () => {
  it('does not apply the discount or waive delivery when the milestone only grants those (no cashback/unlock to fall back on)', async () => {
    const milestone = {
      id: MILESTONE_ID,
      rewardType: 'FLAT_DISCOUNT',
      rewardValue: 10,
      stackableWithCoupon: true,
      grantsFreeDelivery: true,
      cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const { service, cartMilestonesService, orderSplitter } = makeService()
    cartMilestonesService.resolveForCheckout.mockResolvedValue(milestone)
    cartMilestonesService.computeReward.mockReturnValue({ discount: 10, freeDelivery: true })

    const result = await service.placeOrder(USER_ID, { addressId: ADDRESS_ID, paymentMethod: 'COD' })

    expect(result.success).toBe(true)
    const feeContext = orderSplitter.createOrders.mock.calls[0][0].feeContext
    expect(feeContext.couponDiscount).toBe(0)
    expect(feeContext.freeDeliveryOverride).toBe(false)
    expect(cartMilestonesService.recordUsage).not.toHaveBeenCalled()
  })
})

describe('OrdersService.placeOrder — cart milestone on a single-shop cart (unaffected default case)', () => {
  it('still applies the discount and free delivery exactly as before', async () => {
    const singleShopCart = {
      valid: true,
      items: [{ productId: PROD_A, shopId: SHOP_A, quantity: 1, price: 60, lineTotal: 60 }],
      subtotal: 60,
      groupedByShop: new Map([[SHOP_A, [{ productId: PROD_A, shopId: SHOP_A, quantity: 1, price: 60, lineTotal: 60 }]]]),
      failed: [],
      warnings: [],
    }
    const milestone = {
      id: MILESTONE_ID,
      rewardType: 'FLAT_DISCOUNT',
      rewardValue: 10,
      stackableWithCoupon: true,
      grantsFreeDelivery: true,
      cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const singleOrder = [{ id: 'order-a', shopId: SHOP_A, orderNumber: 'A1', status: 'CONFIRMED', totalAmount: 50, createdAt: new Date(), deliveryMode: 'ASAP' }]
    singleOrder.stockTransitions = []
    singleOrder.routeLookups = []

    const { service, cartMilestonesService, orderSplitter } = makeService({
      cartService: {
        validateCart: vi.fn().mockResolvedValue(singleShopCart),
        clearCart: vi.fn().mockResolvedValue(undefined),
      },
      orderSplitter: {
        splitCart: vi.fn().mockReturnValue([]),
        createOrders: vi.fn().mockResolvedValue(singleOrder),
        firePostCommitSideEffects: vi.fn().mockResolvedValue(undefined),
      },
    })
    cartMilestonesService.resolveForCheckout.mockResolvedValue(milestone)
    cartMilestonesService.computeReward.mockReturnValue({ discount: 10, freeDelivery: true })

    const result = await service.placeOrder(USER_ID, { addressId: ADDRESS_ID, paymentMethod: 'COD' })

    expect(result.success).toBe(true)
    const feeContext = orderSplitter.createOrders.mock.calls[0][0].feeContext
    expect(feeContext.couponDiscount).toBe(10)
    expect(feeContext.freeDeliveryOverride).toBe(true)
    expect(cartMilestonesService.recordUsage).toHaveBeenCalledWith(MILESTONE_ID, USER_ID, 'order-a')
  })
})
