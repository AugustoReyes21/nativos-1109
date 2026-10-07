-- Defence in depth: business invariants enforced by PostgreSQL, so a buggy or
-- bypassed endpoint cannot persist impossible financial states. Violations
-- raise SQLSTATE 23514 (check_violation); the API should map it to 409.
-- Verified by tests/db/integrity.test.ts.

CREATE FUNCTION integrity_violation(message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = message; END $$;

-- orders.total_cents must always equal the sum of its items. Deferred to commit
-- so an order and its items can be written in any order inside one transaction.
CREATE FUNCTION check_order_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; expected bigint; actual bigint;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN target := OLD.order_id;
  ELSE target := NEW.order_id; END IF;
  SELECT total_cents INTO actual FROM orders WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(quantity::bigint * price_cents), 0) INTO expected FROM order_items WHERE order_id = target;
  IF expected <> actual THEN PERFORM integrity_violation(format('order %s total %s does not match items %s', target, actual, expected)); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER orders_total_matches_items AFTER INSERT OR UPDATE OF total_cents ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_total();
CREATE CONSTRAINT TRIGGER order_items_total_matches AFTER INSERT OR UPDATE OR DELETE ON order_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_total();

-- A payment charges exactly the server-side total of a live order into an open shift.
-- FOR UPDATE on the order serialises with item edits; FOR SHARE on the shift
-- serialises with closing it (UPDATE takes a conflicting row lock).
CREATE FUNCTION guard_payment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE; s cash_shifts%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE id = NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- foreign key reports it
  IF o.status = 'CANCELADO' THEN PERFORM integrity_violation('cannot charge a cancelled order'); END IF;
  IF NEW.amount_cents <> o.total_cents THEN PERFORM integrity_violation('payment amount must equal order total'); END IF;
  SELECT * INTO s FROM cash_shifts WHERE id = NEW.shift_id FOR SHARE;
  IF FOUND AND s.closed_at IS NOT NULL THEN PERFORM integrity_violation('cash shift is closed'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard_insert BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION guard_payment_insert();

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM integrity_violation(format('%s is append-only', TG_TABLE_NAME)); RETURN NULL; END $$;
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Order lifecycle: identity and creation data never change; CANCELADO is terminal;
-- a paid order cannot be cancelled, re-priced, moved, or reopened once delivered.
CREATE FUNCTION guard_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid boolean;
BEGIN
  IF NEW.id <> OLD.id OR NEW.number <> OLD.number OR NEW.created_at <> OLD.created_at OR NEW.user_id <> OLD.user_id THEN
    PERFORM integrity_violation('order identity and creation data are immutable');
  END IF;
  IF OLD.status = 'CANCELADO' THEN PERFORM integrity_violation('cancelled orders are final'); END IF;
  paid := EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.id);
  IF paid THEN
    IF NEW.status = 'CANCELADO' THEN PERFORM integrity_violation('a paid order cannot be cancelled'); END IF;
    IF NEW.total_cents <> OLD.total_cents OR NEW.table_id <> OLD.table_id THEN PERFORM integrity_violation('a paid order cannot change total or table'); END IF;
    IF OLD.status = 'ENTREGADO' AND NEW.status <> 'ENTREGADO' THEN PERFORM integrity_violation('a paid and delivered order cannot be reopened'); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_guard_update BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_update();

-- Items of paid or cancelled orders are frozen. FOR SHARE on the order waits for
-- an in-flight payment (which holds FOR UPDATE) and then sees it committed.
CREATE FUNCTION guard_order_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; st text;
BEGIN
  FOREACH target IN ARRAY CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.order_id] WHEN 'DELETE' THEN ARRAY[OLD.order_id]
                                     ELSE ARRAY[OLD.order_id, NEW.order_id] END LOOP
    SELECT status INTO st FROM orders WHERE id = target FOR SHARE;
    IF st = 'CANCELADO' THEN PERFORM integrity_violation('items of a cancelled order are final'); END IF;
    IF EXISTS (SELECT 1 FROM payments WHERE order_id = target) THEN PERFORM integrity_violation('items of a paid order are final'); END IF;
  END LOOP;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER order_items_guard BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_order_items();

-- Cash shifts: opening data is immutable, a closed shift is final, shifts are never deleted.
CREATE FUNCTION guard_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM integrity_violation('cash shifts cannot be deleted'); END IF;
  IF OLD.closed_at IS NOT NULL THEN PERFORM integrity_violation('a closed cash shift is final'); END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.opening_cents <> OLD.opening_cents OR NEW.opened_at <> OLD.opened_at THEN
    PERFORM integrity_violation('cash shift opening data is immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_shifts_guard BEFORE UPDATE OR DELETE ON cash_shifts FOR EACH ROW EXECUTE FUNCTION guard_cash_shift();

CREATE FUNCTION guard_cash_movement_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cash_shifts WHERE id = NEW.shift_id AND closed_at IS NOT NULL FOR SHARE) THEN
    PERFORM integrity_violation('cash shift is closed');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_movements_guard_insert BEFORE INSERT ON cash_movements FOR EACH ROW EXECUTE FUNCTION guard_cash_movement_insert();
