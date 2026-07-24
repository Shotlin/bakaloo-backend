// Small, dependency-free geometry helpers for the coverage map's per-pincode
// boundary circles. Coordinates are plain {lat, lng} degrees; math treats
// them as a flat plane, which is accurate enough at city scale.

const KM_PER_DEGREE_LAT = 111

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

/** Approximate lat/lng circle around a center point. */
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
