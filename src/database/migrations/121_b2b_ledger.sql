-- 121_b2b_ledger.sql
--
-- B2B credit ledger — distinct from the existing customer wallet
-- (006_wallet.sql). A wallet holds the customer's OWN prepaid money; a
-- ledger is admin-extended CREDIT: an approved business account (see
-- 120_business_accounts.sql) draws against a monthly limit with no
-- upfront cost, and settles the accumulated balance on a recurring
-- billing cycle.
--
-- Overage model (soft cap): drawing past monthly_credit_limit is ALLOWED
-- and simply billed as part of the normal cycle — never blocked for
-- merely crossing it. hard_limit is the one value actually enforced
-- atomically (mirrors wallets' guarded-UPDATE idiom — see
-- wallet.repository.js#credit's `WHERE balance + $1 <= $maxBalance`), a
-- backstop against runaway/fraudulent draws, not a monthly-limit
-- re-implementation. hard_limit >= monthly_credit_limit always.
--
-- ledger_accounts        — one per business_account (1:1). current_balance
--                           is the live amount owed right now (increases on
--                           DRAW, decreases on REPAYMENT); billing_day
--                           drives which day of the month a cycle opens
--                           for this account (see the billing-cycle worker,
--                           a later phase).
-- ledger_billing_cycles  — one row per (account, monthly period) snapshot
--                           of what was owed and whether it's been settled.
--                           overage_amount is reporting-only (computed at
--                           cycle-open time), never enforced.
-- ledger_transactions    — append-only draw/repayment/adjustment log,
--                           mirroring wallet_transactions' shape.

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_account_id    UUID UNIQUE NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,

  monthly_credit_limit   DECIMAL(10,2) NOT NULL CHECK (monthly_credit_limit > 0),
  -- Atomically enforced backstop (see draw()'s guarded UPDATE) — never the
  -- monthly_credit_limit itself, which is a soft/billing-only figure.
  hard_limit             DECIMAL(10,2) NOT NULL CHECK (hard_limit >= monthly_credit_limit),

  current_balance        DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (current_balance >= 0),

  -- Day of month a new billing cycle opens for this account (capped at 28
  -- so every account gets a real billing date in every month, including
  -- February).
  billing_day            SMALLINT NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 28),

  status                 VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_status ON ledger_accounts(status);
-- Powers the daily billing-cycle worker's "which accounts open a cycle
-- today" scan (WHERE status = 'ACTIVE' AND billing_day = $today).
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_billing_day ON ledger_accounts(billing_day) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS ledger_billing_cycles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_account_id   UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,

  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,

  amount_due          DECIMAL(10,2) NOT NULL DEFAULT 0,
  -- Reporting only — GREATEST(0, amount_due - monthly_credit_limit) at the
  -- moment the cycle was opened. Never re-checked/enforced.
  overage_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  amount_paid         DECIMAL(10,2) NOT NULL DEFAULT 0,

  status              VARCHAR(20) NOT NULL DEFAULT 'DUE'
                        CHECK (status IN ('DUE', 'OVERDUE', 'PAID')),

  due_date            DATE NOT NULL,
  paid_at             TIMESTAMPTZ,
  payment_reference   VARCHAR(255),
  reminder_count      INT NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (ledger_account_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ledger_billing_cycles_account ON ledger_billing_cycles(ledger_account_id, period_start DESC);
-- Powers the daily overdue-sweep (WHERE status = 'DUE' AND due_date < today).
CREATE INDEX IF NOT EXISTS idx_ledger_billing_cycles_status_due ON ledger_billing_cycles(status, due_date) WHERE status IN ('DUE', 'OVERDUE');

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_account_id   UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,

  type                VARCHAR(20) NOT NULL CHECK (type IN ('DRAW', 'REPAYMENT', 'ADJUSTMENT')),
  amount              DECIMAL(10,2) NOT NULL CHECK (amount > 0),

  order_id            UUID REFERENCES orders(id) ON DELETE SET NULL,
  bulk_order_id       UUID REFERENCES bulk_orders(id) ON DELETE SET NULL,
  billing_cycle_id    UUID REFERENCES ledger_billing_cycles(id) ON DELETE SET NULL,

  description         TEXT,
  balance_after       DECIMAL(10,2) NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_account ON ledger_transactions(ledger_account_id, created_at DESC);
