import { ThemeTabsRepository } from '../../../modules/theme-tabs/theme-tabs.repository.js'
import {
  normalizeMerchConfig,
} from '../../../modules/theme-tabs/theme-tabs.shared.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { cacheDeletePattern } from '../../../utils/cache.js'

const repo = new ThemeTabsRepository()

function normalizeTextColor(value) {
  const normalized = `${value || ''}`.trim().toUpperCase()
  if (!normalized) {
    return null
  }

  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : null
}

async function invalidateTabCaches() {
  await cacheDeletePattern('bakaloo:tab_manifest:*')
  await cacheDeletePattern('bakaloo:tab_home:*')
  await cacheDeletePattern('bakaloo:admin_theme_tabs:*')
  await cacheDeletePattern('bakaloo:tab_themes')
}

function compareTabsBySortOrder(a, b) {
  if (a.sort_order !== b.sort_order) {
    return a.sort_order - b.sort_order
  }

  const labelCompare = `${a.label || ''}`.localeCompare(`${b.label || ''}`)
  if (labelCompare !== 0) {
    return labelCompare
  }

  return `${a.id}`.localeCompare(`${b.id}`)
}

async function rebalanceStoreTabs(storeKey, preferredTab = null) {
  if (!storeKey) {
    return
  }

  const activeTabs = await repo.findAll({
    storeKey,
    status: 'active',
  })

  if (!activeTabs.length) {
    return
  }

  const remainingTabs = activeTabs
    .filter((tab) => !preferredTab || tab.id !== preferredTab.id)
    .sort(compareTabsBySortOrder)

  const orderedTabs = [...remainingTabs]

  if (preferredTab && preferredTab.status === 'active') {
    const preferredIndex = Number.isFinite(Number(preferredTab.sort_order))
      ? Number(preferredTab.sort_order)
      : orderedTabs.length
    const clampedIndex = Math.max(0, Math.min(preferredIndex, orderedTabs.length))
    orderedTabs.splice(clampedIndex, 0, preferredTab)
  }

  for (const [index, tab] of orderedTabs.entries()) {
    if (tab.sort_order === index) {
      continue
    }

    await repo.update(tab.id, { sort_order: index })
  }
}

export class ThemeTabsService {
  async list(filters) {
    return repo.findAll({
      storeKey: filters.store_key,
      status: filters.status,
    })
  }

  async getById(id) {
    return repo.findById(id)
  }

  async create(data, adminId, ip) {
    const tab = await repo.create({
      ...data,
      key: `${data.key}`.trim(),
      label: `${data.label}`.trim(),
      image_url: `${data.image_url || ''}`.trim() || null,
      text_color: normalizeTextColor(data.text_color),
      merch_config: normalizeMerchConfig(data.merch_config),
    })

    if (tab.status === 'active') {
      await rebalanceStoreTabs(tab.store_key, tab)
    }

    await invalidateTabCaches()
    logAdminActivity(adminId, 'CREATE_THEME_TAB', 'theme_tab', tab.id, null, null, ip)
    return repo.findById(tab.id)
  }

  async update(id, data, adminId, ip) {
    const existing = await repo.findById(id)
    if (!existing) return null

    const tab = await repo.update(id, {
      ...data,
      ...(data.key !== undefined ? { key: `${data.key}`.trim() } : {}),
      ...(data.label !== undefined ? { label: `${data.label}`.trim() } : {}),
      ...(data.image_url !== undefined
        ? { image_url: `${data.image_url || ''}`.trim() || null }
        : {}),
      ...(data.text_color !== undefined
        ? { text_color: normalizeTextColor(data.text_color) }
        : {}),
      ...(data.merch_config !== undefined
        ? { merch_config: normalizeMerchConfig(data.merch_config) }
        : {}),
    })

    const storesToRebalance = new Set([
      existing.store_key,
      tab?.store_key,
    ].filter(Boolean))

    for (const storeKey of storesToRebalance) {
      if (tab?.status === 'active' && storeKey === tab.store_key) {
        await rebalanceStoreTabs(storeKey, tab)
        continue
      }

      await rebalanceStoreTabs(storeKey)
    }

    await invalidateTabCaches()
    logAdminActivity(adminId, 'UPDATE_THEME_TAB', 'theme_tab', id, null, null, ip)
    return repo.findById(tab.id)
  }

  async archive(id, adminId, ip) {
    const tab = await repo.archive(id)
    if (!tab) return null

    await rebalanceStoreTabs(tab.store_key)
    await invalidateTabCaches()
    logAdminActivity(adminId, 'ARCHIVE_THEME_TAB', 'theme_tab', id, null, null, ip)
    return repo.findById(id)
  }

  async restore(id, adminId, ip) {
    const tab = await repo.restore(id)
    if (!tab) return null

    if (tab.status === 'active') {
      await rebalanceStoreTabs(tab.store_key, tab)
    }
    await invalidateTabCaches()
    logAdminActivity(adminId, 'RESTORE_THEME_TAB', 'theme_tab', id, null, null, ip)
    return repo.findById(id)
  }
}
