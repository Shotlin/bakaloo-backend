import { ExternalLinksRepository } from './external-links.repository.js'

const KEYS = ['business_transaction_url', 'games_url']

/**
 * External Links service — resolves the admin-configurable destination
 * URLs behind the Profile screen's "Business Transaction" button and the
 * Payments section's "Games" button. Both open in the app's existing
 * NavButtonWebviewScreen (in-app WebView, same identity-handoff token as
 * the 5th nav button — see nav-buttons.routes.js's POST /webview-token
 * and webview.routes.js's GET /session), so this module only owns the
 * two target URLs themselves, not the WebView or the handoff token.
 *
 * A blank/unset URL means "button hidden" — the customer app treats an
 * empty string as no destination configured, rather than showing a
 * WebView that loads nothing.
 */
export class ExternalLinksService {
  constructor(repository = new ExternalLinksRepository()) {
    this.repo = repository
  }

  async getConfig() {
    const raw = await this.repo.getMany(KEYS)

    return {
      businessTransactionUrl: this._toStringValue(raw.business_transaction_url),
      gamesUrl: this._toStringValue(raw.games_url),
    }
  }

  async updateConfig({ businessTransactionUrl, gamesUrl }) {
    const current = await this.getConfig()
    const next = {
      businessTransactionUrl: businessTransactionUrl ?? current.businessTransactionUrl,
      gamesUrl: gamesUrl ?? current.gamesUrl,
    }

    for (const [label, value] of Object.entries(next)) {
      if (value === '') continue
      if (!this._isValidHttpUrl(value)) {
        return { success: false, message: `${label} must be a valid http(s) URL` }
      }
    }

    await this.repo.upsert('business_transaction_url', next.businessTransactionUrl)
    await this.repo.upsert('games_url', next.gamesUrl)

    return { success: true, data: next }
  }

  _toStringValue(value) {
    if (typeof value !== 'string') return ''
    return value.trim()
  }

  _isValidHttpUrl(value) {
    if (typeof value !== 'string') return false
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }
}
