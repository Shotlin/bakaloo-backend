import 'dotenv/config'
import { query } from '../src/config/database.js'

// One-off support fix: this phone number is stuck because the existing
// soft-delete (auth.repository.js -> deleteUser) clears profile fields but
// never frees the UNIQUE `phone` column, so a fresh signup with the same
// number keeps hitting the old, deactivated row. This anonymizes that row
// and frees the phone number for a brand-new signup, while leaving orders,
// payments, wallet transactions, etc. in place (orphaned, not deleted) for
// accounting/audit history.
const PHONE = '8888039433'

const { rows: before } = await query(
  `SELECT id, phone, email, name, role, is_active, wallet_balance, created_at
   FROM users WHERE phone = $1`,
  [PHONE]
)

if (before.length === 0) {
  console.log(`No user found with phone ${PHONE}. Nothing to do.`)
  process.exit(0)
}

console.log('Found user(s) to anonymize:')
console.table(before)

const { rows: after } = await query(
  `UPDATE users
   SET phone      = 'DEL_' || substr(id::text, 1, 11),
       email      = NULL,
       name       = NULL,
       avatar_url = NULL,
       fcm_token  = NULL,
       is_active  = false,
       updated_at = NOW()
   WHERE phone = $1
   RETURNING id, phone, email, name, is_active`,
  [PHONE]
)

console.log(`\nDone. Phone ${PHONE} is now free for a fresh signup.`)
console.table(after)
process.exit(0)
