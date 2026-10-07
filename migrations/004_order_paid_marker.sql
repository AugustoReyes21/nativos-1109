-- Paid marker maintained only by the database. Lets the order list find unpaid
-- orders through a small partial index instead of anti-joining every payment
-- ever recorded (measured ~370 ms at 200k historical orders).
ALTER TABLE orders ADD COLUMN paid_at timestamptz;
UPDATE orders o SET paid_at = p.created_at FROM payments p WHERE p.order_id = o.id;

CREATE FUNCTION mark_order_paid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orders SET paid_at = NEW.created_at WHERE id = NEW.order_id;
  RETURN NULL;
END $$;
CREATE TRIGGER payments_mark_order_paid AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION mark_order_paid();

-- Same rules as 002, plus: paid_at is set once, and only when a payment exists.
CREATE OR REPLACE FUNCTION guard_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid boolean;
BEGIN
  IF NEW.id <> OLD.id OR NEW.number <> OLD.number OR NEW.created_at <> OLD.created_at OR NEW.user_id <> OLD.user_id THEN
    PERFORM integrity_violation('order identity and creation data are immutable');
  END IF;
  IF OLD.status = 'CANCELADO' THEN PERFORM integrity_violation('cancelled orders are final'); END IF;
  paid := EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.id);
  IF NEW.paid_at IS DISTINCT FROM OLD.paid_at AND (OLD.paid_at IS NOT NULL OR NOT paid) THEN
    PERFORM integrity_violation('paid_at is maintained by payments');
  END IF;
  IF paid THEN
    IF NEW.status = 'CANCELADO' THEN PERFORM integrity_violation('a paid order cannot be cancelled'); END IF;
    IF NEW.total_cents <> OLD.total_cents OR NEW.table_id <> OLD.table_id THEN PERFORM integrity_violation('a paid order cannot change total or table'); END IF;
    IF OLD.status = 'ENTREGADO' AND NEW.status <> 'ENTREGADO' THEN PERFORM integrity_violation('a paid and delivered order cannot be reopened'); END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_order_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.paid_at IS NOT NULL THEN PERFORM integrity_violation('paid_at is maintained by payments'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_guard_insert BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_insert();

CREATE INDEX orders_unsettled ON orders(created_at) WHERE paid_at IS NULL AND status <> 'CANCELADO';
