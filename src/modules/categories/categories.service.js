import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { simpleSlug } from '../../utils/slugify.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { logger } from '../../config/logger.js'
import { normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'

const CACHE_KEY_ALL = 'categories:all'
const CACHE_TTL = 1800 // 30 minutes
const CACHE_VERSION = 'v2'

/**
 * Categories service — business logic with Redis caching
 */
export class CategoriesService {
  constructor(repository) {
    this.repo = repository
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
   * Get products in a category (paginated)
   */
  async getProducts(categoryId, filters) {
    // Verify category exists
    const category = this._normalizeCategory(await this.repo.findById(categoryId))
    if (!category) return null

    const { offset, limit } = getOffsetLimit(filters)
    const result = await this.repo.findProducts(categoryId, {
      limit,
      offset,
      sort: filters.sort,
      inStock: filters.inStock,
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
