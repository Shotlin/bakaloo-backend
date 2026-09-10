-- 120_business_accounts.sql
--
-- B2B business account application + approval workflow.
--
-- business_accounts         — one row per user who has ever applied
--                              (unique on user_id). status drives what the
--                              account can do: only APPROVED accounts can
--                              flip b2b_enabled, which is what actually
--                              switches pricing/theme to B2B (see
--                              resolveEffectivePriceMode/resolveEffectiveAudience
--                              in src/utils/price-mode.js).
-- business_account_reviews  — append-only audit log of every status
--                              transition an admin makes.
--
-- No document upload in v1 (gst_document_url is nullable, unused by the
-- application flow today) and no multi-staff/company-wide accounts — this
-- is deliberately a single-user, single-GSTIN model; that's what was asked
-- for, and it's a strictly additive migration with no impact on existing
-- flows.

CREATE TABLE IF NOT EXISTS business_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  company_name      VARCHAR(255) NOT NULL,
  gst_number        VARCHAR(15) NOT NULL,
  gst_document_url  TEXT,

  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')),

  -- The customer's own switch — only meaningful once status = 'APPROVED'.
  -- Toggling this is what actually changes which prices/theme they see.
  b2b_enabled       BOOLEAN NOT NULL DEFAULT false,

  rejection_reason  TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_accounts_status ON business_accounts(status);

-- Fraud guard: only one currently-approved account per GSTIN. A GSTIN that
-- was REJECTED or SUSPENDED doesn't block a fresh application from being
-- approved later (e.g. a corrected resubmission).
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_accounts_gst_approved
  ON business_accounts(gst_number) WHERE status = 'APPROVED';

CREATE TABLE IF NOT EXISTS business_account_reviews (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_account_id  UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  reviewer_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  action               VARCHAR(20) NOT NULL
                          CHECK (action IN ('SUBMIT', 'APPROVE', 'REJECT', 'SUSPEND', 'REINSTATE')),
  previous_status      VARCHAR(20) NOT NULL,
  new_status           VARCHAR(20) NOT NULL,
  comments             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_account_reviews_account
  ON business_account_reviews(business_account_id, created_at DESC);
