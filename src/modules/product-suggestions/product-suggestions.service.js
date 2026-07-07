import { ProductSuggestionsRepository } from './product-suggestions.repository.js'
import { cacheDel } from '../../utils/cache.js'

// Shares the exact key shape products.service.js/repository.js use when
// reading this same lookup (findPairWith's category-eligibility cache) —
// keep CACHE_VERSION in sync with any bump there so a write here always
// invalidates the key a subsequent read will actually consult.
const CACHE_VERSION = 'v1'
const CACHE_KEY_PREFIX = `products:pairwith-categories:${CACHE_VERSION}`

/**
 * Product Suggestions service — admin CRUD for the category-to-category
 * "Pair With" mapping (migration 080). products.service.js reads the
 * resulting rules (via the same repository's getTargetCategoryIds, cached)
 * when ranking findPairWith() candidates; this module only owns the
 * dashboard-facing admin read/write side.
 */
export class ProductSuggestionsService {
  constructor(repository = new ProductSuggestionsRepository()) {
    this.repo = repository
  }

  async getRules() {
    return this.repo.getAllRulesGrouped()
  }

  async replaceRules(sourceCategoryId, targetCategoryIds) {
    const uniqueTargets = [...new Set(targetCategoryIds)]

    try {
      const saved = await this.repo.replaceRulesForSource(sourceCategoryId, uniqueTargets)
      // Invalidate the cached lookup findPairWith() consults so the admin's
      // change is reflected on the next request, not after the TTL expires.
      await cacheDel(`${CACHE_KEY_PREFIX}:${sourceCategoryId}`)
      return { success: true, data: saved }
    } catch (err) {
      if (err && err.code === '23503') {
        return { success: false, message: 'One or more category IDs do not exist' }
      }
      throw err
    }
  }
}
