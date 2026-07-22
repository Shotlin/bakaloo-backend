import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { PurchaseLimitsRepository } from './purchase-limits.repository.js'
import { CartRepository } from '../cart/cart.repository.js'

const WINDOW_UNIT_LABEL = { DAY: 'day', WEEK: 'week', MONTH: 'month' }

// "remainingToAdd" for a restricted product whose caps don't currently bind
// (e.g. the per-order cap was just exempted by exemptOrderCapWithOtherItems,
// and the rule has no window cap) — far above any real cart quantity, so it
// never reads as "at limit" while staying a plain non-negative integer.
const UNCAPPED_FOR_THIS_REQUEST = 999999

function windowLabel(period, count) {
  const n = Number(count) || 1
  const unit = WINDOW_UNIT_LABEL[period] || 'period'
  return n === 1 ? unit : `${n} ${unit}s`
}

function isUniqueViolation(err) {
  return err && err.code === '23505'
}

export class PurchaseLimitsService {
  constructor(repository = new PurchaseLimitsRepository(), deps = {}) {
    this.repo = repository
    this.cartRepo = deps.cartRepository || new CartRepository()
  }

  // ────────────────────────────────────────────────────────
  // Admin CRUD
  // ────────────────────────────────────────────────────────

  async listAll() {
    return this.repo.findAll()
  }

  async create(data, actor) {
    const validationError = this._validate(data)
    if (validationError) return { success: false, message: validationError }

    try {
      const rule = await this.repo.create(data, actor.userId)
      emitAudit('purchase_limit_rule_created', {
        actor_user_id: actor.userId,
        actor_role: actor.platformRole || actor.role,
        target_type: 'purchase_limit_rule',
        target_id: rule.id,
        before: null,
        after: rule,
        ip_address: actor.ip,
        user_agent: actor.userAgent,
      })
      logger.info({ ruleId: rule.id, actor: actor.userId }, 'Purchase limit rule created')
      return { success: true, rule }
    } catch (err) {
      if (isUniqueViolation(err)) {
        return {
          success: false,
          message: 'An active rule already exists for this category/product. Edit that rule instead, or deactivate it first.',
        }
      }
      throw err
    }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Rule not found' }

    const merged = { ...existing, ...data }
    const validationError = this._validate(merged, { isUpdate: true })
    if (validationError) return { success: false, message: validationError }

    const rule = await this.repo.update(id, data, actor.userId)
    emitAudit('purchase_limit_rule_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'purchase_limit_rule',
      target_id: id,
      before: existing,
      after: rule,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, rule }
  }

  async toggleActive(id, isActive, actor) {
    return this.update(id, { isActive: !!isActive }, actor)
  }

  async remove(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Rule not found' }
    await this.repo.remove(id)
    emitAudit('purchase_limit_rule_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'purchase_limit_rule',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  /** Mirrors the DB CHECK constraints so the dashboard gets a friendly 400 instead of a raw SQL error. */
  _validate(data, { isUpdate = false } = {}) {
    if (!isUpdate) {
      if (!data.targetType || !['CATEGORY', 'PRODUCT'].includes(data.targetType)) {
        return 'targetType must be CATEGORY or PRODUCT'
      }
      if (data.targetType === 'CATEGORY' && !data.categoryId) {
        return 'categoryId is required for a CATEGORY rule'
      }
      if (data.targetType === 'PRODUCT' && !data.productId) {
        return 'productId is required for a PRODUCT rule'
      }
    }
    if (!data.label || !String(data.label).trim()) {
      return 'label is required'
    }
    const hasOrderCap = data.maxQtyPerOrder != null
    const hasWindowCap = !!data.windowEnabled
    if (!hasOrderCap && !hasWindowCap) {
      return 'Set a per-order limit, a rolling-window limit, or both'
    }
    if (hasWindowCap) {
      if (!['DAY', 'WEEK', 'MONTH'].includes(data.windowPeriod)) {
        return 'windowPeriod must be DAY, WEEK, or MONTH when the window limit is enabled'
      }
      if (!data.windowCount || data.windowCount < 1) {
        return 'windowCount must be at least 1 when the window limit is enabled'
      }
      if (!data.maxQtyPerWindow || data.maxQtyPerWindow < 1) {
        return 'maxQtyPerWindow must be at least 1 when the window limit is enabled'
      }
    }
    return null
  }

  // ────────────────────────────────────────────────────────
  // Enforcement — shared by cart.service.js and order-splitter.service.js
  // ────────────────────────────────────────────────────────

  /**
   * Checks whether adding/holding `cartItems` (the PROJECTED cart state —
   * i.e. already including whatever quantity change the caller is about to
   * persist) would breach the effective rule for `productId`. Returns
   * `{ ok: true }` immediately, with no further queries, when the product
   * has no active rule — this is what guarantees unrestricted categories
   * (vegetables, etc.) are never touched by this feature.
   *
   * @param {string} userId
   * @param {{productId: string, cartItems: Array<{productId:string, quantity:number}>}} args
   * @param {import('pg').PoolClient} [client] - open transaction client (order-splitter only)
   * @returns {Promise<{ok:true, rule?:object} | {ok:false, code:string, message:string, rule:object}>}
   */
  async evaluate(userId, { productId, cartItems }, client = null) {
    const rules = await this.repo.resolveEffectiveRules([productId], client)
    const rule = rules.get(productId)
    if (!rule) return { ok: true }

    const { inScopeQty: cartQtyInScope, hasOtherItems } = await this._analyzeCartForRule(cartItems, rule, client)
    const orderCapApplies = rule.maxQtyPerOrder != null
      && !(rule.exemptOrderCapWithOtherItems && hasOtherItems)

    if (orderCapApplies && cartQtyInScope > rule.maxQtyPerOrder) {
      return {
        ok: false,
        code: 'PURCHASE_LIMIT_ORDER_EXCEEDED',
        message: `Maximum ${rule.maxQtyPerOrder} units of "${rule.label}" allowed per order`,
        rule,
      }
    }

    if (rule.windowEnabled) {
      const windowDays = PurchaseLimitsRepository.windowDaysFor(rule.windowPeriod, rule.windowCount)
      const alreadyBought = await this.repo.getWindowUsage(userId, rule, windowDays, client)
      if (alreadyBought + cartQtyInScope > rule.maxQtyPerWindow) {
        const period = windowLabel(rule.windowPeriod, rule.windowCount)
        const remaining = Math.max(rule.maxQtyPerWindow - alreadyBought, 0)
        return {
          ok: false,
          code: 'PURCHASE_LIMIT_WINDOW_EXCEEDED',
          message: remaining > 0
            ? `Maximum ${rule.maxQtyPerWindow} units of "${rule.label}" allowed every ${period}. You have ${remaining} left this ${period}.`
            : `You've reached your limit of ${rule.maxQtyPerWindow} units of "${rule.label}" for this ${period}`,
          rule,
        }
      }
    }

    return { ok: true, rule }
  }

  /**
   * Same as `evaluate`, but for a whole checkout spanning possibly several
   * shops/products at once (order-splitter.service.js). Resolves rules for
   * every distinct product in one query, and returns one failure entry per
   * offending cart line (mirroring the granularity of the existing
   * max_order_qty checkout failures) so the customer sees exactly which
   * lines to adjust.
   *
   * @param {string} userId
   * @param {Array<{productId:string, shopId:string, quantity:number}>} allItems - every item across every shop in this checkout
   * @param {import('pg').PoolClient} client - open transaction client
   * @returns {Promise<Array<{productId:string, shopId:string, reason:string, code:string}>>}
   */
  async evaluateCheckout(userId, allItems, client) {
    const productIds = allItems.map((i) => i.productId)
    const rules = await this.repo.resolveEffectiveRules(productIds, client)
    if (rules.size === 0) return []

    // Group items by the rule that governs them (dedup by rule.id, not a
    // hand-built scope string) — every item sharing a rule.id competes for
    // the same cap, whether the rule is CATEGORY- or PRODUCT-scoped.
    const itemsByRuleId = new Map()
    const ruleById = new Map()
    for (const item of allItems) {
      const rule = rules.get(item.productId)
      if (!rule) continue
      ruleById.set(rule.id, rule)
      const arr = itemsByRuleId.get(rule.id)
      if (arr) arr.push(item)
      else itemsByRuleId.set(rule.id, [item])
    }
    if (itemsByRuleId.size === 0) return []

    // Sort rule ids so two concurrent checkouts touching overlapping
    // scopes always acquire advisory locks in the same order (deadlock
    // free) — mirrors this codebase's own
    // `Array.from(groups.keys()).sort()` convention in this same file's
    // shop-group loop. Locked per (userId, ruleId): only concurrent
    // checkouts from the SAME user need to serialize against each other,
    // since the cap is per-user.
    const sortedRuleIds = Array.from(itemsByRuleId.keys()).sort()
    for (const ruleId of sortedRuleIds) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${userId}:${ruleId}`])
    }

    const failures = []
    for (const ruleId of sortedRuleIds) {
      const rule = ruleById.get(ruleId)
      const itemsInScope = itemsByRuleId.get(ruleId)
      const cartQtyInScope = itemsInScope.reduce((sum, i) => sum + Number(i.quantity), 0)

      // "Other items" = anything in this same checkout that isn't part of
      // this rule's scope. itemsInScope is a sub-array taken by reference
      // from allItems, so a plain length comparison is enough — no need to
      // re-walk allItems per item.
      const hasOtherItems = itemsInScope.length < allItems.length
      const orderCapApplies = rule.maxQtyPerOrder != null
        && !(rule.exemptOrderCapWithOtherItems && hasOtherItems)

      let failureReason = null
      let failureCode = null
      if (orderCapApplies && cartQtyInScope > rule.maxQtyPerOrder) {
        failureReason = `Maximum ${rule.maxQtyPerOrder} units of "${rule.label}" allowed per order`
        failureCode = 'PURCHASE_LIMIT_ORDER_EXCEEDED'
      } else if (rule.windowEnabled) {
        const windowDays = PurchaseLimitsRepository.windowDaysFor(rule.windowPeriod, rule.windowCount)
        const alreadyBought = await this.repo.getWindowUsage(userId, rule, windowDays, client)
        if (alreadyBought + cartQtyInScope > rule.maxQtyPerWindow) {
          const period = windowLabel(rule.windowPeriod, rule.windowCount)
          failureReason = `Maximum ${rule.maxQtyPerWindow} units of "${rule.label}" allowed every ${period}`
          failureCode = 'PURCHASE_LIMIT_WINDOW_EXCEEDED'
        }
      }

      if (failureReason) {
        for (const item of itemsInScope) {
          failures.push({
            productId: item.productId,
            shopId: item.shopId,
            reason: failureReason,
            code: failureCode,
          })
        }
      }
    }

    return failures
  }

  /**
   * Customer-facing status for a set of products currently on screen —
   * powers the Flutter app's "+" button disabling. Reads the user's live
   * server-side cart so `remainingToAdd` is a single, ready-to-use number
   * (no client-side arithmetic needed): how many more units of this
   * product the customer may add right now, accounting for both caps and
   * whatever is already in their cart. Only restricted products are
   * included in the result — absence means unrestricted.
   *
   * @param {string} userId
   * @param {string[]} productIds
   * @returns {Promise<Array<object>>}
   */
  async getStatusForUser(userId, productIds) {
    const rules = await this.repo.resolveEffectiveRules(productIds, null)
    if (rules.size === 0) return []

    const cartItems = await this.cartRepo.getCart(userId)
    const relevantRules = new Map()
    for (const [pid, rule] of rules) {
      if (!relevantRules.has(rule.id)) relevantRules.set(rule.id, rule)
    }

    const usageByRuleId = new Map()
    for (const rule of relevantRules.values()) {
      if (!rule.windowEnabled) continue
      const windowDays = PurchaseLimitsRepository.windowDaysFor(rule.windowPeriod, rule.windowCount)
      usageByRuleId.set(rule.id, await this.repo.getWindowUsage(userId, rule, windowDays, null))
    }

    const results = []
    for (const productId of productIds) {
      const rule = rules.get(productId)
      if (!rule) continue

      const { inScopeQty: cartQtyInScope, hasOtherItems } = await this._analyzeCartForRule(cartItems, rule, null)
      const orderCapApplies = rule.maxQtyPerOrder != null
        && !(rule.exemptOrderCapWithOtherItems && hasOtherItems)
      const remainingThisOrder = orderCapApplies
        ? Math.max(rule.maxQtyPerOrder - cartQtyInScope, 0)
        : null
      const usedInWindow = usageByRuleId.get(rule.id) ?? 0
      const remainingInWindow = rule.windowEnabled
        ? Math.max(rule.maxQtyPerWindow - usedInWindow - cartQtyInScope, 0)
        : null

      // remainingThisOrder and remainingInWindow can BOTH be null at once —
      // a rule with only a per-order cap (no window cap) whose
      // exemptOrderCapWithOtherItems just kicked in has nothing left to
      // constrain this add right now. The Flutter client's `remainingToAdd`
      // is a non-nullable int (see purchase_limit_status_model.dart), so
      // this can never come back as null even though the rule itself is
      // still "active" — fall back to a large sentinel meaning "nothing
      // stopping you this time" rather than breaking the response shape.
      const remainingToAdd = remainingThisOrder == null && remainingInWindow == null
        ? UNCAPPED_FOR_THIS_REQUEST
        : [remainingThisOrder, remainingInWindow]
            .filter((v) => v != null)
            .reduce((min, v) => (min == null ? v : Math.min(min, v)), null)

      results.push({
        productId,
        categoryId: rule.categoryId,
        ruleLabel: rule.label,
        maxQtyPerOrder: rule.maxQtyPerOrder,
        remainingThisOrder,
        windowEnabled: rule.windowEnabled,
        windowPeriod: rule.windowPeriod,
        windowCount: rule.windowCount,
        maxQtyPerWindow: rule.maxQtyPerWindow,
        usedInWindow: rule.windowEnabled ? usedInWindow : null,
        remainingInWindow,
        remainingToAdd,
        isAtLimit: remainingToAdd <= 0,
        orderCapLifted: !!(rule.exemptOrderCapWithOtherItems && hasOtherItems),
      })
    }
    return results
  }

  /**
   * @private Walks `cartItems` once for whatever `rule` targets (one
   * product, or every product sharing its category), returning both the
   * quantity inside the rule's scope AND whether the cart also holds any
   * item outside that scope. The latter powers
   * `exemptOrderCapWithOtherItems` — a rule can opt out of its own
   * per-order cap the moment the basket isn't "just this restricted
   * product/category alone" (see 087_purchase_limit_rules.sql).
   */
  async _analyzeCartForRule(cartItems, rule, client) {
    if (rule.targetType === 'PRODUCT') {
      let inScopeQty = 0
      let hasOtherItems = false
      for (const item of cartItems) {
        if (item.productId === rule.productId) inScopeQty += Number(item.quantity)
        else hasOtherItems = true
      }
      return { inScopeQty, hasOtherItems }
    }
    const categoryMap = await this.repo.getCategoryMap(cartItems.map((i) => i.productId), client)
    let inScopeQty = 0
    let hasOtherItems = false
    for (const item of cartItems) {
      if (categoryMap.get(item.productId) === rule.categoryId) inScopeQty += Number(item.quantity)
      else hasOtherItems = true
    }
    return { inScopeQty, hasOtherItems }
  }
}
