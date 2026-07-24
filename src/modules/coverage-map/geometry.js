// Small, dependency-free geometry helpers for the coverage map's per-pincode
// boundary shapes. Coordinates are plain {lat, lng} degrees; hull/area math
// treats them as a flat plane, which is accurate enough at city scale (the
// distances involved — a few km — make the earth's curvature negligible).

const KM_PER_DEGREE_LAT = 111

export function dedupePoints(points) {
  const seen = new Set()
  const out = []
  for (const p of points) {
    const key = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(p)
    }
  }
  return out
}

export function centroid(points) {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length
  return { lat, lng }
}

export function haversineKm(a, b) {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function maxDistanceKm(center, points) {
  let max = 0
  for (const p of points) {
    const d = haversineKm(center, p)
    if (d > max) max = d
  }
  return max
}

/** Shoelace formula — used only to detect a degenerate (near-zero-area, collinear) hull. */
export function signedArea(points) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.lat * b.lng - b.lat * a.lng
  }
  return sum / 2
}

/** Andrew's monotone chain convex hull. Returns [] for fewer than 3 points. */
export function convexHull(points) {
  if (points.length < 3) return []

  const pts = [...points].sort((a, b) => a.lat - b.lat || a.lng - b.lng)
  const cross = (o, a, b) =>
    (a.lat - o.lat) * (b.lng - o.lng) - (a.lng - o.lng) * (b.lat - o.lat)

  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }

  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }

  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** Approximate lat/lng circle around a center point, for pincode groups too small for a real hull. */
export function circlePolygon(center, radiusKm, segments = 28) {
  const points = []
  const latRad = (center.lat * Math.PI) / 180
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments
    const dLat = (radiusKm / KM_PER_DEGREE_LAT) * Math.cos(angle)
    const dLng =
      (radiusKm / (KM_PER_DEGREE_LAT * Math.max(Math.cos(latRad), 0.01))) * Math.sin(angle)
    points.push({ lat: center.lat + dLat, lng: center.lng + dLng })
  }
  return points
}
