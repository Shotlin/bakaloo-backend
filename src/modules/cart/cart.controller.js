import { success, error } from '../../utils/apiResponse.js'
import { resolveEffectivePriceMode } from '../../utils/price-mode.js'

/**
 * Cart controller — thin HTTP layer
 */
export class CartController {
  constructor(service, billSummaryService = null, repository = null, productsService = null) {
    this.service = service
    this.billSummaryService = billSummaryService
    this.repo = repository
    this.productsService = productsService
  }

  /**
   * Resolve the effective price mode for this request. The client opts in
   * via `?priceMode=wholesale` (all cart routes require auth, so
   * `request.auth.b2b` is always populated by fastify.authenticate).
   */
  _resolvePriceMode(request) {
    return resolveEffectivePriceMode(request, request.query?.priceMode === 'wholesale')
  }

  /** GET / */
  async get(request, reply) {
    const cart = await this.service.getCart(request.user.id, this._resolvePriceMode(request))
    return reply.code(200).send(success(cart, 'Cart fetched'))
  }

  /** GET /summary */
  async getSummary(request, reply) {
    // BUG FIX: this always priced delivery against the customer's default
    // saved address (addressId hardcoded null), even when they'd selected
    // a different one for this specific order — while placeOrder() (see
    // orders.service.js) always uses the real submitted addressId. Ordering
    // to a non-default address showed one delivery fee/free-delivery
    // threshold in the cart preview and charged a different one at
    // checkout — reported as "sometimes right, sometimes wrong" totals.
    const summary = await this.billSummaryService.getBillSummary(
      request.user.id,
      request.query?.addressId || null,
      {
        quickDeliverySelected: Boolean(request.query?.quickDeliverySelected),
        priceMode: this._resolvePriceMode(request),
      }
    )
    return reply.code(200).send(success(summary, 'Bill summary fetched'))
  }

  /** GET /quick-add — "Quick Add" rail suggestions based on cart contents */
  async getQuickAdd(request, reply) {
    const limit = Math.min(Math.max(Number(request.query?.limit) || 12, 1), 20)
    const priceMode = this._resolvePriceMode(request)
    const cart = await this.service.getCart(request.user.id, priceMode)
    const categoryIds = [...new Set(cart.items.map((item) => item.categoryId).filter(Boolean))]
    const excludeProductIds = cart.items.map((item) => item.productId)

    const products = await this.productsService.getQuickAdd(
      categoryIds,
      excludeProductIds,
      limit,
      { userId: request.user.id },
      priceMode
    )
    return reply.code(200).send(success(products, 'Quick add suggestions'))
  }

  /** POST /items */
  async addItem(request, reply) {
    const result = await this.service.addItem(request.user.id, {
      productId: request.body.productId || null,
      shopId: request.body.shopId || null,
      shopProductId: request.body.shopProductId || null,
      quantity: request.body.quantity,
    }, this._resolvePriceMode(request))
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'CART_ERROR'))
    }
    return reply.code(200).send(success(result.cart, 'Item added to cart'))
  }

  /** PUT /items/:productId */
  async updateItem(request, reply) {
    const result = await this.service.updateItem(
      request.user.id,
      request.params.productId,
      request.body.quantity,
      request.body.shopId || null,
      request.body.shopProductId || null,
      this._resolvePriceMode(request)
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'CART_ERROR'))
    }
    return reply.code(200).send(success(result.cart, 'Cart item updated'))
  }

  /** DELETE /items/:productId */
  async removeItem(request, reply) {
    const result = await this.service.removeItem(
      request.user.id,
      request.params.productId,
      request.query?.shopId || null,
      request.query?.shopProductId || null,
      this._resolvePriceMode(request)
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'CART_ERROR'))
    }
    return reply.code(200).send(success(result.cart, 'Item removed from cart'))
  }

  /** DELETE / */
  async clear(request, reply) {
    await this.service.clearCart(request.user.id)
    return reply.code(200).send(success(null, 'Cart cleared'))
  }

  /** POST /validate */
  async validate(request, reply) {
    const result = await this.service.validateCart(request.user.id, this._resolvePriceMode(request))
    return reply.code(200).send(success(result, 'Cart validated'))
  }

  /** PUT /tip */
  async updateTip(request, reply) {
    await this.repo.setTip(request.user.id, request.body.amount)
    return reply.code(200).send(success({ tipAmount: request.body.amount }, 'Tip updated'))
  }

  /** PUT /delivery-instructions */
  async updateInstructions(request, reply) {
    await this.repo.setInstructions(request.user.id, request.body.instructions)
    return reply.code(200).send(success({
      instructions: request.body.instructions?.trim() || null,
    }, 'Delivery instructions updated'))
  }
}
