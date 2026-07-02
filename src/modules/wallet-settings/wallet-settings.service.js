import { WalletSettingsRepository } from './wallet-settings.repository.js'

const KEYS = [
  'wallet_max_balance',
  'wallet_max_transfer_amount',
  'wallet_min_transfer_amount',
]

const DEFAULTS = {
  maxWalletBalance: 2000,
  maxTransferAmount: 2000,
  minTransferAmount: 1,
}

/**
 * Wallet Settings service — resolves the admin-configurable wallet balance
 * cap and transfer min/max from the `app_settings` table, falling back to
 * safe defaults. This is the single place `WalletService` consults before
 * crediting a wallet or accepting a transfer, so an admin change in the
 * dashboard is actually enforced, not just cosmetic.
 */
export class WalletSettingsService {
  constructor(repository = new WalletSettingsRepository()) {
    this.repo = repository
  }

  async getConfig() {
    const raw = await this.repo.getMany(KEYS)

    return {
      maxWalletBalance: this._toNumber(raw.wallet_max_balance, DEFAULTS.maxWalletBalance),
      maxTransferAmount: this._toNumber(raw.wallet_max_transfer_amount, DEFAULTS.maxTransferAmount),
      minTransferAmount: this._toNumber(raw.wallet_min_transfer_amount, DEFAULTS.minTransferAmount),
    }
  }

  async updateConfig({ maxWalletBalance, maxTransferAmount, minTransferAmount }) {
    const current = await this.getConfig()
    const next = {
      maxWalletBalance: maxWalletBalance ?? current.maxWalletBalance,
      maxTransferAmount: maxTransferAmount ?? current.maxTransferAmount,
      minTransferAmount: minTransferAmount ?? current.minTransferAmount,
    }

    for (const [label, value] of Object.entries(next)) {
      if (!Number.isFinite(value) || value <= 0) {
        return { success: false, message: `${label} must be a positive number` }
      }
    }

    if (next.minTransferAmount > next.maxTransferAmount) {
      return { success: false, message: 'Minimum transfer amount cannot exceed the maximum transfer amount' }
    }
    if (next.maxTransferAmount > next.maxWalletBalance) {
      return { success: false, message: 'Maximum transfer amount cannot exceed the maximum wallet balance' }
    }

    await this.repo.upsert('wallet_max_balance', next.maxWalletBalance)
    await this.repo.upsert('wallet_max_transfer_amount', next.maxTransferAmount)
    await this.repo.upsert('wallet_min_transfer_amount', next.minTransferAmount)

    return { success: true, data: next }
  }

  _toNumber(value, fallback) {
    if (value === undefined || value === null) return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
}
