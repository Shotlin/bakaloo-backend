-- Structured post-delivery refund requests: a customer picks which item(s)
-- had a problem (or all of them) and describes the issue; an admin reviews
-- and approves (moving money via the existing refund primitives) or rejects.
CREATE TABLE refund_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_scope VARCHAR(10) NOT NULL DEFAULT 'ALL' CHECK (item_scope IN ('ALL','SPECIFIC')),
  items JSONB,                    -- snapshot [{productId, name, quantity, total}] for SPECIFIC; NULL for ALL
  description TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  admin_note TEXT,
  processed_by UUID REFERENCES users(id),
  processed_at TIMESTAMPTZ,
  refund_amount DECIMAL(10,2),
  refund_to VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refund_requests_status ON refund_requests(status);
CREATE INDEX idx_refund_requests_order ON refund_requests(order_id);
CREATE INDEX idx_refund_requests_user ON refund_requests(user_id);
