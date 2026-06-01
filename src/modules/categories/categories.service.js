import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { simpleSlug } from '../../utils/slugify.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { logger } from '../../config/logger.js'
import { normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'

const CACHE_KEY_ALL = 'categories:all'
const CACHE_TTL = 1800 // 30 minutes
const CACHE_VERSION = 'v2'

/**
 * Categories service — business logic with Redis caching
 */
export class CategoriesService {
  constructor(repository, deps = {}) {
    this.repo = repository
    this.allocationService =
      deps.allocationService ||
      new AllocationService(new AllocationRepository())
  }

  /**
   * Resolve the customer's allocated shop_ids for product visibility.
   * Returns null for anonymous/admin (legacy unscoped), [] when the
   * customer has zero allocations, or the list of allocated shop ids.
   * Fails closed (returns []) on error so a hiccup never leaks the full
   * catalog to a customer.
   *
   * @param {{ userId?: string }|null|undefined} customerContext
   * @returns {Promise<string[]|null>}
   */
  async _resolveAllocatedShopIds(customerContext) {
    if (!customerContext || !customerContext.userId) return null
    try {
      const ids = await this.allocationService.getShopIdsForUser(
        customerContext.userId
      )
      return Array.isArray(ids) ? ids : []
    } catch (err) {
      logger.error(
        {
          customerId: customerContext.userId,
          err: err.message,
          action: 'categories.resolve_allocations',
        },
        'Failed to resolve customer allocations; returning empty visibility'
      )
      return []
    }
  }

  /**
   * Get all categories — cached for 30 min
   */
  async listAll() {
    const cached = await cacheGet(`${CACHE_KEY_ALL}:${CACHE_VERSION}`)
    if (cached) return cached

    const categories = this._normalizeCategories(await this.repo.findAll())
    await cacheSet(`${CACHE_KEY_ALL}:${CACHE_VERSION}`, categories, CACHE_TTL)
    return categories
  }

  /**
   * Get single category by ID
   */
  async getById(id) {
    const cacheKey = `categories:${CACHE_VERSION}:${id}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const category = this._normalizeCategory(await this.repo.findById(id))
    if (category) {
      await cacheSet(cacheKey, category, CACHE_TTL)
    }
    return category
  }

  /**
   * Get products in a category (paginated).
   *
   * @param {string} categoryId
   * @param {object} filters - page/limit/sort/inStock/groupOptions
   * @param {{ userId?: string }|null} [customerContext] - When present the
   *   product list is scoped to the customer's allocated shops.
   */
  async getProducts(categoryId, filters, customerContext = null) {
    // Verify category exists
    const category = this._normalizeCategory(await this.repo.findById(categoryId))
    if (!category) return null

    const { offset, limit } = getOffsetLimit(filters)

    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)
    // Customer with zero allocations sees an empty (but valid) page.
    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return {
        data: [],
        pagination: buildPagination({
          page: filters.page || 1,
          limit,
          total: 0,
        }),
      }
    }

    const result = await this.repo.findProducts(categoryId, {
      limit,
      offset,
      sort: filters.sort,
      inStock: filters.inStock,
      groupOptions: filters.groupOptions === true || filters.groupOptions === 'true',
      allocatedShopIds,
    })

    return {
      data: this._normalizeProducts(result.data),
      pagination: buildPagination({
        page: filters.page || 1,
        limit,
        total: result.total,
      }),
    }
  }

  /**
   * Create a new category [ADMIN]
   */
  async create(data) {
    const slug = simpleSlug(data.name)

    // Check slug uniqueness
    const existing = await this.repo.findBySlug(slug)
    if (existing) {
      return { success: false, message: 'A category with this name already exists' }
    }

    const category = await this.repo.create({ ...data, slug })

    // Invalidate cache
    await cacheDeletePattern('categories:*')
    logger.info({ categoryId: category.id }, 'Category created')

    return { success: true, category: this._normalizeCategory(category) }
  }

  /**
   * Update a category [ADMIN]
   */
  async update(id, data) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Category not found' }

    // If name changed, regenerate slug
    if (data.name && data.name !== existing.name) {
      data.slug = simpleSlug(data.name)
      const slugExists = await this.repo.findBySlug(data.slug)
      if (slugExists && slugExists.id !== id) {
        return { success: false, message: 'A category with this name already exists' }
      }
    }

    const category = await this.repo.update(id, data)

    await cacheDeletePattern('categories:*')
    logger.info({ categoryId: id }, 'Category updated')

    return { success: true, category: this._normalizeCategory(category) }
  }

  /**
   * Delete (deactivate) a category [ADMIN]
   */
  async delete(id) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Category not found' }

    await this.repo.delete(id)

    await cacheDeletePattern('categories:*')
    logger.info({ categoryId: id }, 'Category deleted')

    return { success: true }
  }

  _normalizeCategories(categories = []) {
    return categories.map((category) => this._normalizeCategory(category))
  }

  _normalizeCategory(category) {
    if (!category) return category

    return {
      ...category,
      image_url: normalizeCloudinaryDeliveryUrl(category.image_url, 'default'),
    }
  }

  _normalizeProducts(products = []) {
    return products.map((product) => ({
      ...product,
      thumbnail_url: normalizeCloudinaryDeliveryUrl(product.thumbnail_url, 'default'),
    }))
  }
}
