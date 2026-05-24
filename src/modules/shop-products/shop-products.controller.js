import { success, error } from '../../utils/apiResponse.js'
import {
  createShopProductSchema,
  updateShopProductSchema,
  stockUpdateSchema,
  listShopProductsQuerySchema,
  shopProductIdParamSchema,
} from './shop-products.schema.js'

/**
 * Shop Products controller — thin HTTP layer.
 * Handles request/response shape only and delegates to the service.
 *
 * Shop scope is set by the `requireShopScope` preHandler on every route that
 * mounts this controller; here we just read `request.shopId`.
 */
export class ShopProductsController {
  constructor(service) {
    this.service = service
  }

  /**
   * Build the actor object used by the service for authz checks.
   * Resolves both kebab and camel case shop role keys so we don't accidentally
   * break when the JWT shape evolves between auth tasks.
   * @private
   */
  _actor(request) {
    return {
      id: request.user?.id,
      role: request.user?.role,
      shopRole: request.user?.shopRole || request.user?.shop_role,
    }
  }

  /** @private */
  _statusForCode(code) {
    switch (code) {
      case 'SHOP_PRODUCT_NOT_FOUND':
        return 404
      case 'UNAUTHORIZED':
        return 401
      case 'FORBIDDEN':
        return 403
      case 'SHOP_PRODUCT_DUPLICATE':
        return 409
      default:
        return 400
    }
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')
  }

  /** @private */
  _missingShopReply(reply) {
    return reply
      .code(400)
      .send(
        error(
          'shop_id is required (JWT or X-Shop-Id header)',
          'SHOP_ID_REQUIRED'
        )
      )
  }

  // ────────────────────────────────────────────────────────
  // POST / — Create a shop_product
  // ────────────────────────────────────────────────────────
  async create(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const parsed = createShopProductSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.create(
      request.shopId,
      parsed.data,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply.code(201).send(success(result.data, 'Shop product created'))
  }

  // ────────────────────────────────────────────────────────
  // GET / — List shop_products (paginated, filterable)
  // ────────────────────────────────────────────────────────
  async list(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const parsed = listShopProductsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.list(request.shopId, parsed.data)
    return reply.code(200).send(success(result, 'Shop products fetched'))
  }

  // ────────────────────────────────────────────────────────
  // GET /:id — Get a single shop_product
  // ────────────────────────────────────────────────────────
  async getOne(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const record = await this.service.getById(
      request.shopId,
      paramsParsed.data.id
    )
    if (!record) {
      return reply
        .code(404)
        .send(error('Shop product not found', 'SHOP_PRODUCT_NOT_FOUND'))
    }

    return reply.code(200).send(success(record, 'Shop product fetched'))
  }

  // ────────────────────────────────────────────────────────
  // PATCH /:id — Update non-stock fields
  // ────────────────────────────────────────────────────────
  async update(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = updateShopProductSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.update(
      request.shopId,
      paramsParsed.data.id,
      bodyParsed.data,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.data, 'Shop product updated'))
  }

  // ────────────────────────────────────────────────────────
  // PATCH /:id/stock — Stock update (FOR UPDATE row lock)
  // ────────────────────────────────────────────────────────
  async updateStock(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = stockUpdateSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.updateStock(
      request.shopId,
      paramsParsed.data.id,
      bodyParsed.data,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply
      .code(200)
      .send(
        success(
          { shopProduct: result.data, prev: result.prev },
          'Stock updated'
        )
      )
  }

  // ────────────────────────────────────────────────────────
  // DELETE /:id — Soft-delete
  // ────────────────────────────────────────────────────────
  async delete(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.delete(
      request.shopId,
      paramsParsed.data.id,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply.code(200).send(success(null, 'Shop product deleted'))
  }
}
