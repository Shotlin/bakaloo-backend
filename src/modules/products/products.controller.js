import { success, error } from '../../utils/apiResponse.js'
import { query } from '../../config/database.js'

/**
 * Build a customer scoping context from the authenticated request.
 *
 * Returns:
 *   - { userId } when the request comes from an authenticated CUSTOMER —
 *     downstream service applies allocation-based product visibility
 *     (Requirements 1.5, 4.5, 11.5).
 *   - null for anonymous requests OR for ADMIN / RIDER / shop-staff
 *     callers; those bypass customer scoping so admin dashboards and
 *     internal flows continue to see the full master catalog.
 *
 * Keeping this resolver in the controller layer (HTTP boundary) means
 * the service stays unaware of JWT claim shape and can be exercised
 * directly from tests.
 *
 * @param {object} request
 * @returns {{ userId: string }|null}
 */
function resolveCustomerContext(request) {
  const user = request?.user
  if (!user || !user.id) return null
  // Only customers are scoped. ADMIN/RIDER/shop-staff sessions retain
  // legacy unscoped behaviour to preserve existing internal contracts.
  if (user.role && user.role !== 'CUSTOMER') return null
  return { userId: user.id }
}

/**
 * Products controller — thin HTTP layer
 */
export class ProductsController {
  constructor(service) {
    this.service = service
  }

  /** GET / — List products */
  async list(request, reply) {
    const customerContext = resolveCustomerContext(request)
    const result = await this.service.list(request.query, customerContext)
    return reply.code(200).send(
      success(result.data, 'Products fetched', { pagination: result.pagination })
    )
  }

  /** GET /search — Hybrid search with fuzzy suggestions */
  async search(request, reply) {
    const { q, ...filters } = request.query
    const customerContext = resolveCustomerContext(request)
    const result = await this.service.search(q, filters, customerContext)
    return reply.code(200).send(
      success(result.data, 'Search results', {
        pagination: result.pagination,
        suggestions: result.suggestions || [],
      })
    )
  }

  /** GET /featured — Featured products */
  async featured(request, reply) {
    const customerContext = resolveCustomerContext(request)
    const products = await this.service.getFeatured(customerContext)
    return reply.code(200).send(success(products, 'Featured products'))
  }

  /** GET /price-drops — Products with price drops */
  async getPriceDrops(request, reply) {
    const limit = Math.min(parseInt(request.query.limit, 10) || 10, 20)
    const customerContext = resolveCustomerContext(request)
    const products = await this.service.getPriceDrops(limit, customerContext)
    return reply.code(200).send(success(products, 'Price drop products fetched'))
  }

  /** GET /last-minute — Last-minute craving products */
  async getLastMinute(request, reply) {
    const limit = Math.min(parseInt(request.query.limit, 10) || 10, 20)
    const customerContext = resolveCustomerContext(request)
    const products = await this.service.getLastMinute(limit, customerContext)
    return reply.code(200).send(success(products, 'Last-minute products fetched'))
  }

  /** GET /:id — Single product */
  async getOne(request, reply) {
    const customerContext = resolveCustomerContext(request)
    const product = await this.service.getByIdOrSlug(
      request.params.id,
      customerContext
    )
    if (!product) {
      return reply.code(404).send(error('Product not found', 'NOT_FOUND'))
    }

    // Fire-and-forget product view tracking
    const userId = request.user?.id || null
    const productId = product.id
    setImmediate(() => {
      query(
        'INSERT INTO product_views (product_id, user_id) VALUES ($1, $2)',
        [productId, userId]
      ).catch(() => { })
    })

    return reply.code(200).send(success(product, 'Product fetched'))
  }

  /** GET /:id/related — Related products */
  async getRelated(request, reply) {
    const customerContext = resolveCustomerContext(request)
    const products = await this.service.getRelated(
      request.params.id,
      customerContext
    )
    if (products === null) {
      return reply.code(404).send(error('Product not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(products, 'Related products'))
  }

  /** GET /:id/options — All purchasable options for a product family */
  async getOptions(request, reply) {
    const customerContext = resolveCustomerContext(request)
    const result = await this.service.getProductOptions(
      request.params.id,
      customerContext
    )
    if (!result) {
      return reply.code(404).send(error('Product not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result, 'Product options fetched'))
  }

  /** POST / — Create product */
  async create(request, reply) {
    const result = await this.service.create(request.body)
    return reply.code(201).send(success(result.product, 'Product created'))
  }

  /** PUT /:id — Update product */
  async update(request, reply) {
    const result = await this.service.update(request.params.id, request.body)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.product, 'Product updated'))
  }

  /** PUT /:id/stock — Update stock */
  async updateStock(request, reply) {
    const result = await this.service.updateStock(request.params.id, request.body.stock)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.product, 'Stock updated'))
  }

  /** DELETE /:id — Delete product */
  async delete(request, reply) {
    const result = await this.service.delete(request.params.id)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Product deleted'))
  }
}
