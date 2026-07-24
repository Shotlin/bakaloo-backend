import { CoverageMapRepository } from './coverage-map.repository.js'
import { convexHull, circlePolygon, centroid, maxDistanceKm, signedArea, dedupePoints } from './geometry.js'

// Smallest boundary drawn for a pincode with too few points for a real hull
// (a single customer, or a couple of customers right on top of each other).
const MIN_BOUNDARY_RADIUS_KM = 0.35

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

  /** Real hull for 3+ distinct points; a circle around the centroid otherwise. */
  _boundaryFor(group) {
    const unique = dedupePoints(group)

    if (unique.length >= 3) {
      const hull = convexHull(unique)
      if (hull.length >= 3 && Math.abs(signedArea(hull)) > 1e-10) {
        return hull.map((p) => [p.lat, p.lng])
      }
    }

    const center = centroid(unique)
    const radiusKm =
      unique.length <= 1
        ? MIN_BOUNDARY_RADIUS_KM
        : Math.max(MIN_BOUNDARY_RADIUS_KM, maxDistanceKm(center, unique) * 1.15)
    return circlePolygon(center, radiusKm).map((p) => [p.lat, p.lng])
  }
}
