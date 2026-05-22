import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { generateSlug } from '../../utils/slugify.js'
import { logger } from '../../config/logger.js'
import { normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'

const CACHE_TTL_LIST = 600     // 10 min for lists
const CACHE_TTL_FEATURED = 1800 // 30 min for featured
const CACHE_TTL_DETAIL = 900   // 15 min for single product
const CACHE_VERSION = 'v2'

/**
 * Products service — business logic with Redis caching
 */
export class ProductsService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * List products with filters (cached by filter combination)
   */
  async list(filters) {
    const cacheKey = `products:list:${CACHE_VERSION}:${JSON.stringify(filters)}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const result = this._normalizeProductListResult(await this.repo.findMany(filters))
    await cacheSet(cacheKey, result, CACHE_TTL_LIST)
    return result
  }

  /**
   * Hybrid search — prefix FTS + ILIKE + fuzzy suggestions
   * Accepts single character queries for instant suggestions
   */
  async search(q, filters) {
    const trimmed = String(q || '').trim()

    if (!trimmed) {
      return {
        data: [],
        suggestions: [],
        pagination: {
          page: Number(filters?.page) || 1,
          limit: Number(filters?.limit) || 20,
          total: 0,
          totalPages: 0,
        },
      }
    }

    // search queries bypass cache for freshness
    try {
      return this._normalizeProductListResult(await this.repo.fullTextSearch(trimmed, filters))
    } catch (err) {
      logger.warn({ err: err.message, q: trimmed }, 'Search query failed, falling back to ILIKE')
      const result = this._normalizeProductListResult(await this.repo.findMany({ ...filters, search: trimmed }))
      return { ...result, suggestions: [] }
    }
  }

  /**
   * Featured products (cached 30 min)
   */
  async getFeatured() {
    const cacheKey = `products:featured:${CACHE_VERSION}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const products = this._normalizeProducts(await this.repo.findFeatured())
    await cacheSet(cacheKey, products, CACHE_TTL_FEATURED)
    return products
  }

  /**
   * Get single product detail
   */
  async getById(id) {
    const cacheKey = `products:detail:${CACHE_VERSION}:${id}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const product = this._normalizeProduct(await this.repo.findById(id))
    if (product) {
      await cacheSet(cacheKey, product, CACHE_TTL_DETAIL)
    }
    return product
  }

  /**
   * Get product by slug (public-facing)
   */
  async getBySlug(slug) {
    const cacheKey = `products:slug:${CACHE_VERSION}:${slug}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const product = this._normalizeProduct(await this.repo.findBySlug(slug))
    if (product) {
      await cacheSet(cacheKey, product, CACHE_TTL_DETAIL)
    }
    return product
  }

  /**
   * Get product by ID or slug (auto-detect)
   */
  async getByIdOrSlug(identifier) {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)
    return isUUID ? this.getById(identifier) : this.getBySlug(identifier)
  }

  /**
   * Get related products (same category)
   */
  async getRelated(id) {
    const product = await this.repo.findById(id)
    if (!product) return null

    return this._normalizeProducts(await this.repo.findRelated(id, product.category_id))
  }

  async getPairWith(productId, categoryId, limit = 10) {
    return this._normalizeProducts(
      await this.repo.findPairWith(productId, categoryId, limit)
    )
  }

  async getPriceDrops(limit = 10) {
    return this._normalizeProducts(await this.repo.getPriceDrops(limit))
  }

  async getLastMinute(limit = 10) {
    return this._normalizeProducts(await this.repo.getLastMinute(limit))
  }

  /**
   * Create product [ADMIN]
   */
  async create(data) {
    const productData = {
      ...data,
      slug: generateSlug(data.name),
    }

    const product = await this.repo.create(productData)

    // Invalidate list/featured caches
    await cacheDeletePattern('products:list:*')
    await cacheDeletePattern('products:featured')
    logger.info({ productId: product.id }, 'Product created')

    return { success: true, product: this._normalizeProduct(product) }
  }

  /**
   * Update product [ADMIN]
   */
  async update(id, data) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Product not found' }

    const updateData = { ...data }

    // Re-generate slug if name changed
    if (updateData.name && updateData.name !== existing.name) {
      updateData.slug = generateSlug(updateData.name)
    }

    const product = await this.repo.update(id, updateData)

    await cacheDeletePattern('products:*')
    logger.info({ productId: id }, 'Product updated')

    return { success: true, product: this._normalizeProduct(product) }
  }

  /**
   * Update stock [ADMIN]
   */
  async updateStock(id, stock) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Product not found' }

    const product = await this.repo.updateStock(id, stock)

    await cacheDeletePattern(`products:detail:${id}`)
    await cacheDeletePattern('products:list:*')

    return { success: true, product }
  }

  /**
   * Delete (deactivate) product [ADMIN]
   */
  async delete(id) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Product not found' }

    await this.repo.delete(id)

    await cacheDeletePattern('products:*')
    logger.info({ productId: id }, 'Product deleted')

    return { success: true }
  }

  _normalizeProductListResult(result) {
    if (!result) return result

    return {
      ...result,
      data: this._normalizeProducts(result.data),
      suggestions: this._normalizeProducts(result.suggestions),
    }
  }

  _normalizeProducts(products = []) {
    return products.map((product) => this._normalizeProduct(product))
  }

  _normalizeProduct(product) {
    if (!product) return product

    return {
      ...product,
      thumbnail_url: normalizeCloudinaryDeliveryUrl(product.thumbnail_url, 'default'),
      images: Array.isArray(product.images)
        ? product.images.map((image) => normalizeCloudinaryDeliveryUrl(image, 'default'))
        : product.images,
    }
  }
}
