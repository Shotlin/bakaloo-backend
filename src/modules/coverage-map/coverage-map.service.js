import { CoverageMapRepository } from './coverage-map.repository.js'
import { circlePolygon, centroid, maxDistanceKm } from './geometry.js'

// Every pincode's boundary is a circle around its customers' centroid —
// never a hull connecting individual customers. A hull looked fine for
// tightly-clustered points, but the moment one pincode had even a couple
// of far-flung/bad-data addresses it drew a huge, meaningless triangle
// spanning half the map. Radius is clamped so a pincode's shape always
// reads as "a local area", not a shape stretched across states.
const MIN_BOUNDARY_RADIUS_KM = 0.35
const MAX_BOUNDARY_RADIUS_KM = 3

export class CoverageMapService {
  constructor(repository = new CoverageMapRepository()) {
    this.repo = repository
  }

  async getCoverage(shopId) {
    const shop = await this.repo.getShop(shopId)
    if (!shop) {
      return { success: false, message: 'Shop not found' }
    }

    const customers = await this.repo.getCoveredCustomers(shopId)

    const byPincode = new Map()
    for (const customer of customers) {
      const key = customer.pincode || 'UNKNOWN'
      if (!byPincode.has(key)) byPincode.set(key, [])
      byPincode.get(key).push(customer)
    }

    const boundaries = []
    for (const [pincode, group] of byPincode) {
      boundaries.push({
        pincode,
        count: group.length,
        polygon: this._boundaryFor(group),
      })
    }

    const serviceablePincodes = shop.serviceable_pincodes || []
    const uncoveredPincodes = serviceablePincodes.filter((p) => !byPincode.has(p))

    return {
      success: true,
      data: {
        shop: {
          id: shop.id,
          name: shop.name,
          lat: Number(shop.lat),
          lng: Number(shop.lng),
          city: shop.city,
          state: shop.state,
          pincode: shop.pincode,
          isActive: shop.is_active,
        },
        serviceablePincodes,
        uncoveredPincodes,
        customers: customers.map((c) => ({
          userId: c.userId,
          name: c.name,
          initial: this._initial(c.name),
          lat: c.lat,
          lng: c.lng,
          pincode: c.pincode,
          hasActiveOrder: c.hasActiveOrder,
        })),
        boundaries,
        totalCustomers: customers.length,
      },
    }
  }

  _initial(name) {
    const trimmed = (name || '').trim()
    return trimmed ? trimmed[0].toUpperCase() : '?'
  }

  /** A circle around the group's centroid, radius clamped to [MIN, MAX]. */
  _boundaryFor(group) {
    const center = centroid(group)
    const radiusKm = Math.min(
      MAX_BOUNDARY_RADIUS_KM,
      Math.max(MIN_BOUNDARY_RADIUS_KM, maxDistanceKm(center, group) * 1.15)
    )
    return circlePolygon(center, radiusKm).map((p) => [p.lat, p.lng])
  }
}
