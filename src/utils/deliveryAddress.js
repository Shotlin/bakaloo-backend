/**
 * `orders.delivery_address` is a JSONB snapshot spread of the `addresses`
 * row at checkout time (see orders/orders.service.js), so it retains the
 * original `addresses.id` — the stable key for "same saved address" used
 * by the sticky rider-preference lookup and the area-segment exact-match
 * resolver. Defensively parses in case the column ever arrives as a raw
 * JSON string (mirrors invoiceGenerator.js#parseOrderShape).
 */
export function extractAddressId(deliveryAddress) {
  if (!deliveryAddress) return null
  const address = typeof deliveryAddress === 'string' ? JSON.parse(deliveryAddress) : deliveryAddress
  return address?.id || null
}
