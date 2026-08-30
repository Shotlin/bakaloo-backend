import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CartController } from '../../../src/modules/cart/cart.controller.js'

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
const ADDRESS_ID = '22222222-2222-2222-2222-222222222222'

/**
 * Regression coverage for GET /cart/summary — previously hardcoded
 * addressId to null regardless of which saved address the customer had
 * selected for this order, always pricing delivery against their default
 * address. orders.service.js#placeOrder always uses the real submitted
 * addressId, so ordering to a non-default address showed one delivery
 * fee/free-delivery threshold in the preview and charged a different one
 * at checkout.
 */
describe('CartController.getSummary — forwards the selected addressId', () => {
  let billSummaryService
  let controller
  let reply

  beforeEach(() => {
    billSummaryService = { getBillSummary: vi.fn().mockResolvedValue({ totalPayable: 100 }) }
    controller = new CartController(null, billSummaryService)
    reply = createReplyMock()
  })

  it('passes the query addressId through to getBillSummary', async () => {
    const request = {
      user: { id: USER_ID },
      query: { addressId: ADDRESS_ID },
    }

    await controller.getSummary(request, reply)

    expect(billSummaryService.getBillSummary).toHaveBeenCalledWith(
      USER_ID,
      ADDRESS_ID,
      expect.objectContaining({ quickDeliverySelected: false })
    )
  })

  it('falls back to null (the customer default address) when no addressId is given', async () => {
    const request = { user: { id: USER_ID }, query: {} }

    await controller.getSummary(request, reply)

    expect(billSummaryService.getBillSummary).toHaveBeenCalledWith(
      USER_ID,
      null,
      expect.objectContaining({ quickDeliverySelected: false })
    )
  })
})
