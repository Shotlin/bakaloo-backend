import { BusinessAccountsRepository } from './business-accounts.repository.js'

export class BusinessAccountsService {
  constructor(repository = new BusinessAccountsRepository()) {
    this.repo = repository
  }

  async getMine(userId) {
    return this.repo.findByUserId(userId)
  }

  /**
   * Apply for B2B status. A user gets exactly one business_accounts row
   * (unique user_id) — a REJECTED application can be resubmitted (resets
   * to PENDING), but an existing PENDING/APPROVED/SUSPENDED one cannot be
   * re-applied over.
   */
  async apply(userId, { companyName, gstNumber, gstDocumentUrl = null }) {
    const existing = await this.repo.findByUserId(userId)

    if (existing) {
      if (existing.status === 'REJECTED') {
        const resubmitted = await this.repo.resubmit(existing.id, {
          companyName,
          gstNumber,
          gstDocumentUrl,
        })
        return { success: true, account: resubmitted }
      }
      return {
        success: false,
        message: `You already have a business account application (status: ${existing.status})`,
        code: 'ALREADY_APPLIED',
      }
    }

    const account = await this.repo.create({ userId, companyName, gstNumber, gstDocumentUrl })
    return { success: true, account }
  }

  /**
   * Flip the customer's own enable/disable switch. Only reachable once the
   * application is APPROVED — this is what actually changes which prices
   * and theme the account sees (via resolveEffectivePriceMode reading
   * request.auth.b2b, populated fresh from this same table on every
   * authenticated request — never a stale JWT claim).
   */
  async setEnabled(userId, enabled) {
    const account = await this.repo.findByUserId(userId)
    if (!account) {
      return { success: false, message: 'No business account application found', code: 'NOT_FOUND' }
    }
    if (account.status !== 'APPROVED') {
      return {
        success: false,
        message: `Business account must be APPROVED to toggle B2B mode (current status: ${account.status})`,
        code: 'NOT_APPROVED',
      }
    }
    const updated = await this.repo.setEnabled(userId, enabled)
    return { success: true, account: updated }
  }
}
