/**
 * Shared QR pickup-token revocation — every place an order's active pickup
 * credential must stop working: rider reassignment (finalize-assignment),
 * the order being cancelled, the order being delivered, and a shop-staff
 * rider reassignment. One SQL statement, called from inside each caller's
 * existing transaction rather than duplicated per call site.
 */
export async function revokeOrderPickupTokens(client, orderId, reason) {
  await client.query(
    `UPDATE order_pickup_tokens
     SET status = 'REVOKED', revoked_at = NOW(), revoked_reason = $2
     WHERE order_id = $1 AND status IN ('ACTIVE', 'VERIFIED')`,
    [orderId, reason]
  )
}
