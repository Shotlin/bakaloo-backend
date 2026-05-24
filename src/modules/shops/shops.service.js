import { cacheGet, cacheSet, cacheDel, cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'

const CACHE_PREFIX = 'bakaloo:shops:v1'
const CACHE_TTL = 300 // 300 seconds

/**
 * Shops service — business logic with Redis caching
 * Handles slug generation, branch code generation, cache invalidation
 */
export class ShopsService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Create a new shop
   * Generates unique slug and branch_code
   * @param {object} data - Validated shop data
   * @param {string} userId - Creator's user ID
   * @returns {Promise<object>}
   */
  async create(data, userId) {
    const slug = await this.generateUniqueSlug(data.name)
    const branchCode = await this.generateBranchCode(data.city)

    const shop = await this.repo.create({
      ...data,
      slug,
      branch_code: branchCode,
      created_by: userId,
    })

    // Invalidate active shops list cache
    await cacheDeletePattern('bakaloo:shops:active:*')

    logger.info({ userId, shopId: shop.id, action: 'shop_created' }, 'Shop created')

    return shop
  }

  /**
   * Get shop by ID (cached)
   * @param {string} id - Shop UUID
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    const cacheKey = `${CACHE_PREFIX}:${id}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const shop = await this.repo.findById(id)
    if (shop) {
      await cacheSet(cacheKey, shop, CACHE_TTL)
    }
    return shop
  }

  /**
   * List shops with filters and pagination
   * @param {object} filters - Query filters
   * @returns {Promise<object>}
   */
  async list(filters) {
    const { shops, total } = await this.repo.findMany(filters)
    return {
      shops,
      total,
      page: filters.page,
      limit: filters.limit,
    }
  }

  /**
   * Update shop by ID
   * Regenerates slug if name changes
   * @param {string} id - Shop UUID
   * @param {object} data - Fields to update
   * @param {string} userId - Updater's user ID
   * @returns {Promise<{success: boolean, shop?: object, message?: string}>}
   */
  async update(id, data, userId) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    const updateData = { ...data }

    // Regenerate slug if name changed
    if (updateData.name && updateData.name !== existing.name) {
      updateData.slug = await this.generateUniqueSlug(updateData.name)
    }

    const shop = await this.repo.update(id, updateData)
    if (!shop) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    // Invalidate caches
    await cacheDel(`${CACHE_PREFIX}:${id}`)
    await cacheDeletePattern('bakaloo:shops:active:*')

    logger.info({ userId, shopId: id, action: 'shop_updated' }, 'Shop updated')

    return { success: true, shop }
  }

  /**
   * Soft-delete shop by ID
   * @param {string} id - Shop UUID
   * @param {string} userId - Deleter's user ID
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async delete(id, userId) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    const deleted = await this.repo.softDelete(id)
    if (!deleted) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    // Invalidate caches
    await cacheDel(`${CACHE_PREFIX}:${id}`)
    await cacheDeletePattern('bakaloo:shops:active:*')

    logger.info({ userId, shopId: id, action: 'shop_deleted' }, 'Shop soft-deleted')

    return { success: true }
  }

  /**
   * Generate a unique slug from shop name
   * 1. Lowercase the name
   * 2. Replace spaces and special characters with hyphens
   * 3. Remove consecutive hyphens
   * 4. If slug exists, append -1, -2, etc. until unique
   * @param {string} name - Shop name
   * @returns {Promise<string>}
   */
  async generateUniqueSlug(name) {
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')

    // Check for existing slugs with same base
    const existingSlugs = await this.repo.findSlugsLike(baseSlug)

    if (existingSlugs.length === 0) {
      return baseSlug
    }

    // Find the highest numeric suffix
    let maxSuffix = 0
    for (const slug of existingSlugs) {
      if (slug === baseSlug) {
        maxSuffix = Math.max(maxSuffix, 0)
        continue
      }
      const match = slug.match(new RegExp(`^${baseSlug}-(\\d+)$`))
      if (match) {
        maxSuffix = Math.max(maxSuffix, parseInt(match[1], 10))
      }
    }

    return `${baseSlug}-${maxSuffix + 1}`
  }

  /**
   * Generate a unique branch code
   * Format: CITY_PREFIX + sequential number (e.g., MUM001, DEL002)
   * @param {string} city - City name
   * @returns {Promise<string>}
   */
  async generateBranchCode(city) {
    const prefix = city
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 3)
      .padEnd(3, 'X')

    // Find highest existing branch code with this prefix
    let code
    let counter = 1
    const maxAttempts = 100

    while (counter <= maxAttempts) {
      code = `${prefix}${String(counter).padStart(3, '0')}`
      const existing = await this.repo.findByBranchCode(code)
      if (!existing) break
      counter++
    }

    return code
  }
}
