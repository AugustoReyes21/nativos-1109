-- Operational selection lease, not a reservation of physical seats.
CREATE TABLE table_claims (
  table_id uuid PRIMARY KEY REFERENCES restaurant_tables(id),
  claim_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX table_claims_session ON table_claims(session_id);
CREATE INDEX orders_table_active ON orders(table_id,user_id)
  WHERE status IN ('PENDIENTE','EN_PREPARACION','LISTO') OR (status='ENTREGADO' AND paid_at IS NULL);
