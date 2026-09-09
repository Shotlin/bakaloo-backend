import { getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { SpinWheelRepository } from './spin-wheel.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { WalletService } from '../wallet/wallet.service.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { UsersRepository } from '../users/users.repository.js'

const COUPON_REQUIRED_TYPES = new Set(['FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE'])
const MAX_ACTIVE_PRIZES = 8
const MIN_ACTIVE_PRIZES = 2
const PROBABILITY_SUM_TOLERANCE = 0.5

/**
 * Pure weighted-pick — exported standalone so the property test can drive
 * it directly with thousands of trials and a real (or seeded) RNG, with no
 * DB/service scaffolding involved. `prizes` must already be the resolved
 * active set (see SpinWheelService#_validateActiveSetForSpin) with each
 * item's `winProbability` a 0-100 number.
 *
 * @param {Array<{winProbability:number}>} prizes
 * @param {() => number} [random] - defaults to Math.random; inject a
 *   seeded generator in tests.
 */
export function pickWeightedPrize(prizes, random = Math.random) {
  const roll = random() * 100
  let cumulative = 0
  for (const prize of prizes) {
    cumulative += prize.winProbability
    if (roll < cumulative) return prize
  }
  // Floating-point rounding can leave the cumulative sum a hair under 100
  // (e.g. 99.99999998) — fall back to the last prize rather than ever
  // returning undefined.
  return prizes[prizes.length - 1]
}

export class SpinWheelService {
  constructor(
    repo = new SpinWheelRepository(),
    couponsRepo = new CouponsRepository(),
    walletService = new WalletService(new WalletRepository()),
    usersRepo = new UsersRepository()
  ) {
    this.repo = repo
    this.couponsRepo = couponsRepo
    this.walletService = walletService
    this.usersRepo = usersRepo
  }

  // ─── Customer-facing ────────────────────────────────────────────────────

  /** Active prizes for rendering the wheel — deliberately excludes winProbability and linkedCouponId (odds/internal wiring aren't the client's business). */
  async getActivePrizesForCustomer() {
    const prizes = await this.repo.findActivePrizes()
    return prizes.map((p) => ({
      id: p.id,
      type: p.type,
      iconKey: p.iconKey,
      label: p.label,
      value: p.value,
      displayOrder: p.displayOrder,
    }))
  }

  async getEligibility(userId) {
    const [settings, wallet] = await Promise.all([
      this.repo.getSettings(),
      this.repo.peekSpinWallet(userId),
    ])
    const spinsAvailable = wallet.grantedToday
      ? wallet.availableSpins
      : wallet.availableSpins + settings.dailyFreeSpins
    return {
      spinsAvailable,
      dailyFreeSpins: settings.dailyFreeSpins,
      triggerMode: settings.triggerMode,
    }
  }

  _validateActiveSetForSpin(prizes) {
    if (prizes.length < MIN_ACTIVE_PRIZES || prizes.length > MAX_ACTIVE_PRIZES) {
      return { ok: false, reason: `active prize count ${prizes.length} out of range ${MIN_ACTIVE_PRIZES}-${MAX_ACTIVE_PRIZES}` }
    }
    const sum = prizes.reduce((total, p) => total + p.winProbability, 0)
    if (Math.abs(sum - 100) > PROBABILITY_SUM_TOLERANCE) {
      return { ok: false, reason: `active probabilities sum to ${sum}, expected 100` }
    }
    return { ok: true }
  }

  /**
   * The core transaction: lazily grants today's daily spin if not yet
   * granted, rejects if the user has none left, otherwise decrements and
   * resolves a winner. Reward issuance (§ below) deliberately happens
   * AFTER this transaction commits — mirrors orders.service.js's
   * post-commit follow-through (e.g. lines ~792-807) rather than trying to
   * fold a coupon-targeting/wallet-credit call into the same DB
   * transaction, so a reward-issuance failure can never roll back (and
   * thus hide) a spin the customer already saw resolve.
   */
  async spin(userId) {
    const client = await getClient()
    let wonPrize = null
    let spinsRemaining = 0
    let historyId = null
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateSpinWalletForUpdate(client, userId)
      const settings = await this.repo.getSettings()

      let availableSpins = wallet.availableSpins
      const markDailyGranted = !wallet.grantedToday
      if (!wallet.grantedToday && settings.dailyFreeSpins > 0) {
        availableSpins += settings.dailyFreeSpins
      }

      if (availableSpins <= 0) {
        await this.repo.setSpinWallet(client, userId, { availableSpins, markDailyGranted })
        await client.query('COMMIT')
        return { success: false, message: 'No spins available' }
      }

      const prizes = await this.repo.findActivePrizes()
      const validation = this._validateActiveSetForSpin(prizes)
      if (!validation.ok) {
        await client.query('ROLLBACK')
        logger.error({ userId, reason: validation.reason }, 'Spin blocked: wheel misconfigured')
        return { success: false, message: 'Spin wheel is not configured correctly — please contact support.' }
      }

      availableSpins -= 1
      await this.repo.setSpinWallet(client, userId, { availableSpins, markDailyGranted })

      const won = pickWeightedPrize(prizes)
      historyId = await this.repo.insertHistory(client, {
        userId,
        prizeId: won.id,
        prizeType: won.type,
        prizeLabel: won.label,
        prizeValue: won.value,
        isWin: won.type !== 'BETTER_LUCK',
        rewardStatus: 'N_A',
      })

      await client.query('COMMIT')
      wonPrize = won
      spinsRemaining = availableSpins
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId }, 'Spin transaction failed')
      return { success: false, message: 'Something went wrong — please try again.' }
    } finally {
      client.release()
    }

    const { rewardStatus, rewardRef } = await this._issueReward(userId, wonPrize, historyId)
    await this.repo.updateHistoryReward(historyId, { rewardStatus, rewardRef })

    return {
      success: true,
      prize: {
        id: wonPrize.id,
        type: wonPrize.type,
        iconKey: wonPrize.iconKey,
        label: wonPrize.label,
        value: wonPrize.value,
        isWin: wonPrize.type !== 'BETTER_LUCK',
      },
      rewardStatus,
      spinsRemaining,
    }
  }

  /**
   * Issues the actual reward — CASHBACK credits the wallet directly
   * (subType 'SCRATCH', previously-unused per 068_first_time_offers_and_
   * cashback.sql); every other winning type targets a pre-linked
   * INDIVIDUAL coupon via the same coupon_target_users mechanism
   * cart_milestones/first_time_offers already use (CouponsRepository#
   * addTargetUser). Never throws — a failure here must never take away a
   * win the customer already saw the wheel land on; it's recorded as
   * reward_status='FAILED' for an admin to fix manually (see spin_history
   * / GET /spin-wheel/history) instead.
   */
  async _issueReward(userId, prize, historyId) {
    if (prize.type === 'BETTER_LUCK') {
      return { rewardStatus: 'N_A', rewardRef: null }
    }
    if (prize.type === 'CASHBACK') {
      try {
        const result = await this.walletService.addMoney(userId, {
          amount: prize.value,
          description: 'Spin & Win prize',
          subType: 'SCRATCH',
          sourceId: historyId,
        })
        if (result.success) {
          return { rewardStatus: 'ISSUED', rewardRef: result.transaction?.id ?? null }
        }
        logger.warn({ userId, historyId, message: result.message }, 'Spin win wallet credit failed')
        return { rewardStatus: 'FAILED', rewardRef: null }
      } catch (err) {
        logger.error({ err, userId, historyId }, 'Spin win wallet credit threw')
        return { rewardStatus: 'FAILED', rewardRef: null }
      }
    }
    // Coupon-requiring types (FREE_DELIVERY / PERCENTAGE_OFF / FLAT_OFF / BUY_ONE_GET_ONE)
    if (!prize.linkedCouponId) {
      logger.warn({ userId, historyId, prizeType: prize.type }, 'Spin win has no linked coupon')
      return { rewardStatus: 'FAILED', rewardRef: null }
    }
    try {
      await this.couponsRepo.addTargetUser(prize.linkedCouponId, userId)
      return { rewardStatus: 'ISSUED', rewardRef: prize.linkedCouponId }
    } catch (err) {
      logger.error({ err, userId, historyId }, 'Spin win coupon targeting failed')
      return { rewardStatus: 'FAILED', rewardRef: null }
    }
  }

  /**
   * Grants bonus spins for any admin-defined milestone rule this user has
   * newly earned — called (fire-and-forget) from every place an order can
   * reach DELIVERED. Takes the same user_spin_wallet row lock spin() uses,
   * as the FIRST step, so two orders delivered near-simultaneously for one
   * user can't both grant a non-repeating rule (the second evaluation
   * blocks on the lock until the first commits its dedupe-defeating
   * spin_credit_grants row).
   */
  async evaluateMilestones(userId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateSpinWalletForUpdate(client, userId)
      const rules = await this.repo.findActiveMilestoneRules()
      if (rules.length === 0) {
        await client.query('COMMIT')
        return
      }
      const stats = await this.usersRepo.getStats(userId)
      let totalGrant = 0
      for (const rule of rules) {
        const statValue = rule.milestoneType === 'ORDER_COUNT'
          ? stats.total_orders
          : parseFloat(stats.total_spent)
        const alreadyGranted = await this.repo.countGrantsForRule(userId, rule.id, client)
        let toGrant = 0
        if (rule.isRepeating) {
          const earnedMultiples = Math.floor(statValue / rule.threshold)
          toGrant = Math.max(0, earnedMultiples - alreadyGranted)
        } else if (alreadyGranted === 0 && statValue >= rule.threshold) {
          toGrant = 1
        }
        for (let i = 0; i < toGrant; i++) {
          await this.repo.insertGrant(client, {
            userId, amount: rule.bonusSpins, source: 'MILESTONE', sourceRef: rule.id,
          })
          totalGrant += rule.bonusSpins
        }
      }
      if (totalGrant > 0) {
        await this.repo.setSpinWallet(client, userId, {
          availableSpins: wallet.availableSpins + totalGrant,
          markDailyGranted: wallet.grantedToday,
        })
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId }, 'Spin milestone evaluation failed')
    } finally {
      client.release()
    }
  }

  // ─── Admin: prizes ──────────────────────────────────────────────────────

  async listPrizes() {
    return this.repo.findAllPrizes()
  }

  /**
   * Mirrors CartMilestonesService#_validateCouponUnlock exactly — a
   * coupon-requiring prize being activated must point at a real, active,
   * INDIVIDUAL-target coupon, or the "win" would silently do nothing at
   * checkout. Inactive prizes are exempt (a template with no coupon linked
   * yet is a legitimate, expected state — see the seed data in migration
   * 118).
   */
  async _validatePrizeCoupon(data) {
    if (!COUPON_REQUIRED_TYPES.has(data.type)) return null
    if (data.isActive === false) return null
    if (!data.linkedCouponId) {
      return `${data.type} prizes need a linked coupon before they can go active — link one from the Coupons page first.`
    }
    const coupon = await this.couponsRepo.findById(data.linkedCouponId)
    if (!coupon) return 'Selected coupon was not found'
    if (coupon.targetType !== 'INDIVIDUAL') {
      return `"${coupon.code}" must have its Target Audience set to "Individual" to work as a spin prize — it's currently "${coupon.targetType}".`
    }
    if (!coupon.isActive) {
      return `"${coupon.code}" is inactive — activate it before linking it as a spin prize.`
    }
    return null
  }

  async createPrize(data, actor) {
    if (!data.type || !data.label) {
      return { success: false, message: 'type and label are required' }
    }
    const couponError = await this._validatePrizeCoupon(data)
    if (couponError) return { success: false, message: couponError }
    if (data.isActive !== false) {
      const activeCount = await this.repo.countActive()
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.createPrize(data)
    emitAudit('spin_prize_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
      target_id: prize.id,
      before: null,
      after: prize,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, prize }
  }

  async updatePrize(id, data, actor) {
    const existing = await this.repo.findPrizeById(id)
    if (!existing) return { success: false, message: 'Prize not found' }
    const merged = { ...existing, ...data }
    const couponError = await this._validatePrizeCoupon(merged)
    if (couponError) return { success: false, message: couponError }
    if (merged.isActive !== false && !existing.isActive) {
      const activeCount = await this.repo.countActive(id)
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.updatePrize(id, data)
    emitAudit('spin_prize_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
      target_id: id,
      before: existing,
      after: prize,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, prize }
  }

  async deletePrize(id, actor) {
    const existing = await this.repo.findPrizeById(id)
    if (!existing) return { success: false, message: 'Prize not found' }
    await this.repo.deletePrize(id)
    emitAudit('spin_prize_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  async reorderPrizes(orderedIds, actor) {
    await this.repo.reorderPrizes(orderedIds)
    emitAudit('spin_prizes_reordered', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
      target_id: null,
      before: null,
      after: { count: orderedIds.length },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  // ─── Admin: settings ────────────────────────────────────────────────────

  async getSettings() {
    return this.repo.getSettings()
  }

  async updateSettings(data, actor) {
    const before = await this.repo.getSettings()
    const settings = await this.repo.updateSettings(data)
    emitAudit('spin_wheel_settings_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_wheel_settings',
      target_id: settings.id,
      before,
      after: settings,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, settings }
  }

  // ─── Admin: milestone rules ─────────────────────────────────────────────

  async listMilestoneRules() {
    return this.repo.findAllMilestoneRules()
  }

  async createMilestoneRule(data, actor) {
    if (!data.milestoneType || data.threshold == null) {
      return { success: false, message: 'milestoneType and threshold are required' }
    }
    const rule = await this.repo.createMilestoneRule(data)
    emitAudit('spin_milestone_rule_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_milestone_rule',
      target_id: rule.id,
      before: null,
      after: rule,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, rule }
  }

  async updateMilestoneRule(id, data, actor) {
    const existing = await this.repo.findMilestoneRuleById(id)
    if (!existing) return { success: false, message: 'Milestone rule not found' }
    const rule = await this.repo.updateMilestoneRule(id, data)
    emitAudit('spin_milestone_rule_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_milestone_rule',
      target_id: id,
      before: existing,
      after: rule,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, rule }
  }

  async deleteMilestoneRule(id, actor) {
    const existing = await this.repo.findMilestoneRuleById(id)
    if (!existing) return { success: false, message: 'Milestone rule not found' }
    await this.repo.deleteMilestoneRule(id)
    emitAudit('spin_milestone_rule_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_milestone_rule',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  // ─── Admin: manual grant + history ──────────────────────────────────────

  async grantSpins(targetUserId, amount, actor) {
    if (!targetUserId || !amount || amount <= 0) {
      return { success: false, message: 'targetUserId and a positive amount are required' }
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateSpinWalletForUpdate(client, targetUserId)
      const newBalance = wallet.availableSpins + amount
      await this.repo.setSpinWallet(client, targetUserId, {
        availableSpins: newBalance,
        markDailyGranted: wallet.grantedToday,
      })
      await this.repo.insertGrant(client, {
        userId: targetUserId, amount, source: 'ADMIN', sourceRef: actor.userId, createdBy: actor.userId,
      })
      await client.query('COMMIT')
      emitAudit('spin_credits_granted', {
        actor_user_id: actor.userId,
        actor_role: actor.platformRole || actor.role,
        target_type: 'user_spin_wallet',
        target_id: targetUserId,
        before: null,
        after: { amount, newBalance },
        ip_address: actor.ip,
        user_agent: actor.userAgent,
      })
      return { success: true, spinsAvailable: newBalance }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, targetUserId, amount }, 'Grant spins failed')
      return { success: false, message: 'Failed to grant spins' }
    } finally {
      client.release()
    }
  }

  async listHistory(params) {
    return this.repo.listHistory(params)
  }
}
