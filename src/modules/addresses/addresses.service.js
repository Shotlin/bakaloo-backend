import { logger } from '../../config/logger.js'
import { query } from '../../config/database.js'
import { env } from '../../config/env.js'

const MAX_ADDRESSES = 10

// ─── Dynamic serviceable pincodes from DB ─────────────────
let cachedPincodes = null
let pincodesCacheTime = 0
const PINCODE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function getServiceablePincodes() {
  const now = Date.now()
  if (cachedPincodes && (now - pincodesCacheTime) < PINCODE_CACHE_TTL) {
    return cachedPincodes
  }

  try {
    const { rows } = await query(
      `SELECT value FROM app_settings WHERE key = 'serviceable_pincodes'`
    )

    if (rows[0]?.value) {
      let raw = rows[0].value
      // Handle JSONB — might already be an array or a JSON string
      if (typeof raw === 'string') {
        raw = JSON.parse(raw)
      }
      cachedPincodes = new Set(Array.isArray(raw) ? raw.map(String) : [])
    } else {
      // Fallback: Kolkata pincodes 700001–700157
      cachedPincodes = new Set(
        Array.from({ length: 157 }, (_, i) => String(700001 + i))
      )
    }

    pincodesCacheTime = now
    logger.info({ count: cachedPincodes.size }, 'Serviceable pincodes loaded from DB')
    return cachedPincodes
  } catch (err) {
    logger.error({ err }, 'Failed to load serviceable pincodes — using fallback')
    return new Set(Array.from({ length: 157 }, (_, i) => String(700001 + i)))
  }
}

/**
 * Addresses service — business logic for delivery addresses
 */
export class AddressesService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Get all addresses for a user
   */
  async list(userId) {
    return this.repo.findByUser(userId)
  }

  /**
   * Create a new address
   */
  async create(userId, data) {
    if (!this._hasValidCoordinates(data.lat, data.lng)) {
      return {
        success: false,
        message: 'Map pin is required. Please select your exact location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }

    const count = await this.repo.countByUser(userId)
    if (count >= MAX_ADDRESSES) {
      return { success: false, message: `Maximum ${MAX_ADDRESSES} addresses allowed` }
    }

    // First address or explicitly default
    if (data.isDefault || count === 0) {
      data.isDefault = true
    }

    const address = await this.repo.create(userId, data)

    // If set as default, unset others
    if (data.isDefault && count > 0) {
      await this.repo.setDefault(address.id, userId)
    }

    logger.info({ userId, addressId: address.id }, 'Address created')
    return { success: true, address }
  }

  /**
   * Update an address
   */
  async update(userId, id, data) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    const hasLat = Object.prototype.hasOwnProperty.call(data, 'lat')
    const hasLng = Object.prototype.hasOwnProperty.call(data, 'lng')
    if (hasLat !== hasLng) {
      return {
        success: false,
        message: 'Latitude and longitude must be updated together.',
        code: 'ADDRESS_COORDINATES_INCOMPLETE',
      }
    }
    if (hasLat && !this._hasValidCoordinates(data.lat, data.lng)) {
      return {
        success: false,
        message: 'Map pin is invalid. Please select your location again.',
        code: 'ADDRESS_COORDINATES_INVALID',
      }
    }
    if (!hasLat && !this._hasValidCoordinates(existing.lat, existing.lng)) {
      return {
        success: false,
        message: 'Map pin is required. Please update this address location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }

    const address = await this.repo.update(id, userId, data)
    logger.info({ userId, addressId: id }, 'Address updated')
    return { success: true, address }
  }

  /**
   * Delete an address
   */
  async delete(userId, id) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    await this.repo.delete(id, userId)

    // If deleted the default, promote newest remaining
    if (existing.isDefault) {
      const remaining = await this.repo.findByUser(userId)
      if (remaining.length > 0) {
        await this.repo.setDefault(remaining[0].id, userId)
      }
    }

    logger.info({ userId, addressId: id }, 'Address deleted')
    return { success: true }
  }

  /**
   * Set as default address
   */
  async setDefault(userId, id) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    const address = await this.repo.setDefault(id, userId)
    logger.info({ userId, addressId: id }, 'Default address set')
    return { success: true, address }
  }

  /**
   * Validate pincode for delivery availability
   */
  async validatePincode(pincode) {
    if (env.ALLOW_ALL_PINCODES) {
      return {
        available: true,
        deliveryFee: 29,
        estimatedMin: 30,
      }
    }

    const serviceablePincodes = await getServiceablePincodes()
    const available = serviceablePincodes.has(pincode)
    return {
      available,
      deliveryFee: available ? 29 : 0,
      estimatedMin: available ? 30 : 0,
    }
  }

  _hasValidCoordinates(lat, lng) {
    const parsedLat = Number(lat)
    const parsedLng = Number(lng)
    return Number.isFinite(parsedLat) &&
      Number.isFinite(parsedLng) &&
      parsedLat >= -90 &&
      parsedLat <= 90 &&
      parsedLng >= -180 &&
      parsedLng <= 180
  }
}
