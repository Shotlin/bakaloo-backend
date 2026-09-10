export const ACTIVE_THEME_CACHE_PREFIX = 'bakaloo:active_theme'
export const LEGACY_TAB_CACHE_KEY = 'bakaloo:tab_themes'
export const ADMIN_TAB_THEMES_CACHE_PREFIX = 'bakaloo:admin_theme_tabs'
export const SECTION_CACHE_PREFIX = 'bakaloo:sections'
export const SECTION_PUBLIC_CACHE_PREFIX = 'bakaloo:sections:public'
export const TAB_MANIFEST_CACHE_PREFIX = 'bakaloo:tab_manifest'
export const TAB_HOME_CACHE_PREFIX = 'bakaloo:tab_home'

/**
 * The legacy "one globally-active theme" cache key became one-per-audience
 * (migration 123 — see idx_one_active_theme_per_audience). Was a bare
 * constant; now a function, same as every other audience/store-scoped key
 * here. Invalidation deletes the whole prefix (cacheDeletePattern) rather
 * than one specific audience, same as every other pattern-based key below.
 */
export function getActiveThemeCacheKey(audience = 'B2C') {
  return `${ACTIVE_THEME_CACHE_PREFIX}:${audience}`
}

export function getAdminTabThemesCacheKey(storeKey = 'all', status = 'all') {
  return `${ADMIN_TAB_THEMES_CACHE_PREFIX}:${storeKey}:${status}`
}

export function getTabManifestCacheKey(storeKey = 'zepto', audience = 'B2C') {
  return `${TAB_MANIFEST_CACHE_PREFIX}:${storeKey}:${audience}`
}

export function getSectionCacheKey(tabId) {
  return `${SECTION_CACHE_PREFIX}:${tabId}`
}

export function getSectionPublicCacheKey(storeKey = 'zepto', tabKey = 'all', audience = 'B2C') {
  return `${SECTION_PUBLIC_CACHE_PREFIX}:${storeKey}:${tabKey}:${audience}`
}

export function getTabHomeCacheKey(storeKey = 'zepto', key = 'all') {
  return `${TAB_HOME_CACHE_PREFIX}:${storeKey}:${key}`
}
