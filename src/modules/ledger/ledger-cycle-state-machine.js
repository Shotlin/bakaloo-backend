// Pure state machine for ledger_billing_cycles.status (no I/O, no DB, no
// logger) — mirrors payout-state-machine.js's shape so the ledger-billing
// worker (src/workers/ledger-billing.worker.js) can decide the next state
// before any side effect (DB UPDATE, account suspend/reactivate).
//
// Transition table:
//
//   DUE      + EXPIRE   → OVERDUE   (due_date has passed, still unpaid)
//   DUE      + PAY      → PAID
//   OVERDUE  + PAY      → PAID
//   PAID     + (any)    → PAID      (terminal — idempotent reconciliation)
//   anything else       → null      (rejected)

/** Allowed ledger_billing_cycles.status values (kept in sync with the DB CHECK constraint). */
export const LEDGER_CYCLE_STATES = Object.freeze(['DUE', 'OVERDUE', 'PAID'])

/** Allowed events that can drive a transition. */
export const LEDGER_CYCLE_EVENTS = Object.freeze(['EXPIRE', 'PAY'])

/**
 * Compute the next ledger_billing_cycles.status for the given (state, event).
 * Pure: returns a string from LEDGER_CYCLE_STATES on a valid transition, or
 * `null` when the transition is not allowed — the caller treats `null` as
 * "reject event, keep current state."
 *
 * @param {string} currentState - one of LEDGER_CYCLE_STATES
 * @param {string} event - one of LEDGER_CYCLE_EVENTS
 * @returns {string|null}
 */
export function nextLedgerCycleState(currentState, event) {
  // Terminal: PAID swallows every event so reconciliation is idempotent.
  if (currentState === 'PAID') return 'PAID'

  if (currentState === 'DUE') {
    if (event === 'EXPIRE') return 'OVERDUE'
    if (event === 'PAY') return 'PAID'
    return null
  }

  if (currentState === 'OVERDUE') {
    if (event === 'PAY') return 'PAID'
    return null
  }

  return null
}
