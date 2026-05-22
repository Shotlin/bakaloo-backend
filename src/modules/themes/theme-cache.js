export const ACTIVE_THEME_CACHE_KEY = 'bakaloo:active_theme'
export const LEGACY_TAB_CACHE_KEY = 'bakaloo:tab_themes'
export const ADMIN_TAB_THEMES_CACHE_PREFIX = 'bakaloo:admin_theme_tabs'
export const SECTION_CACHE_PREFIX = 'bakaloo:sections'
export const SECTION_PUBLIC_CACHE_PREFIX = 'bakaloo:sections:public'
export const TAB_MANIFEST_CACHE_PREFIX = 'bakaloo:tab_manifest'
export const TAB_HOME_CACHE_PREFIX = 'bakaloo:tab_home'

export function getAdminTabThemesCacheKey(storeKey = 'all', status = 'all') {
  return `${ADMIN_TAB_THEMES_CACHE_PREFIX}:${storeKey}:${status}`
}

export function getTabManifestCacheKey(storeKey = 'zepto') {
  return `${TAB_MANIFEST_CACHE_PREFIX}:${storeKey}`
}

export function getSectionCacheKey(tabId) {
  return `${SECTION_CACHE_PREFIX}:${tabId}`
}

export function getSectionPublicCacheKey(storeKey = 'zepto', tabKey = 'all') {
  return `${SECTION_PUBLIC_CACHE_PREFIX}:${storeKey}:${tabKey}`
}

export function getTabHomeCacheKey(storeKey = 'zepto', key = 'all') {
  return `${TAB_HOME_CACHE_PREFIX}:${storeKey}:${key}`
}
