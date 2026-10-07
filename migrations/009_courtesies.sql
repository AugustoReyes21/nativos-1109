ALTER TABLE orders ADD COLUMN courtesy_cents integer NOT NULL DEFAULT 0 CHECK(courtesy_cents BETWEEN 0 AND total_cents);
CREATE TABLE order_courtesies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  shift_id uuid NOT NULL REFERENCES cash_shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 300),
  items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 50),
  amount_cents integer NOT NULL CHECK(amount_cents>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_courtesies_order ON order_courtesies(order_id);
CREATE INDEX order_courtesies_shift ON order_courtesies(shift_id);
CREATE VIEW courtesy_quantities AS
  SELECT c.order_id,(i->>'productId')::uuid AS product_id,sum((i->>'quantity')::integer)::integer AS quantity
  FROM order_courtesies c CROSS JOIN LATERAL jsonb_array_elements(c.items) i GROUP BY c.order_id,(i->>'productId')::uuid;

CREATE FUNCTION guard_courtesy_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE; s cash_shifts%ROWTYPE; item jsonb; line order_items%ROWTYPE;
  qty integer; prior integer; calculated bigint:=0; seen uuid[]:=ARRAY[]::uuid[];
BEGIN
  SELECT * INTO s FROM cash_shifts WHERE id=NEW.shift_id FOR SHARE;
  IF NOT FOUND OR s.closed_at IS NOT NULL THEN PERFORM integrity_violation('courtesy requires an open cash shift'); END IF;
  SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR o.status='CANCELADO' OR o.paid_at IS NOT NULL THEN PERFORM integrity_violation('courtesy requires an unsettled order'); END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN role_permissions r ON r.role=u.role WHERE u.id=NEW.user_id AND u.active AND r.permission='courtesies.create') THEN
    PERFORM integrity_violation('courtesy author must be authorized');
  END IF;
  IF jsonb_typeof(NEW.items)<>'array' OR jsonb_array_length(NEW.items) NOT BETWEEN 1 AND 50 THEN PERFORM integrity_violation('invalid courtesy items'); END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
    IF jsonb_typeof(item)<>'object' OR NOT (item ? 'productId' AND item ? 'quantity')
      OR item - 'productId' - 'quantity' <> '{}'::jsonb OR jsonb_typeof(item->'quantity')<>'number'
      OR (item->>'quantity') !~ '^[0-9]+$' THEN PERFORM integrity_violation('invalid courtesy item'); END IF;
    SELECT * INTO line FROM order_items WHERE order_id=o.id AND product_id=(item->>'productId')::uuid;
    IF NOT FOUND OR line.product_id=ANY(seen) THEN PERFORM integrity_violation('invalid or repeated courtesy product'); END IF;
    seen:=array_append(seen,line.product_id); qty:=(item->>'quantity')::integer;
    SELECT coalesce(quantity,0) INTO prior FROM courtesy_quantities WHERE order_id=o.id AND product_id=line.product_id;
    IF qty<1 OR qty+coalesce(prior,0)>line.quantity THEN PERFORM integrity_violation('courtesy exceeds ordered quantity'); END IF;
    calculated:=calculated+qty::bigint*line.price_cents;
  END LOOP;
  IF calculated<=0 OR calculated+o.courtesy_cents>o.total_cents THEN PERFORM integrity_violation('courtesy exceeds order total'); END IF;
  NEW.amount_cents:=calculated;
  RETURN NEW;
END $$;
CREATE TRIGGER courtesies_guard_insert BEFORE INSERT ON order_courtesies FOR EACH ROW EXECUTE FUNCTION guard_courtesy_insert();
CREATE TRIGGER courtesies_immutable BEFORE UPDATE OR DELETE ON order_courtesies FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER courtesies_no_truncate BEFORE TRUNCATE ON order_courtesies FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE FUNCTION mark_order_courtesy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orders SET courtesy_cents=(SELECT sum(amount_cents) FROM order_courtesies WHERE order_id=NEW.order_id),version=version+1 WHERE id=NEW.order_id;
  RETURN NULL;
END $$;
CREATE TRIGGER courtesies_mark_order AFTER INSERT ON order_courtesies FOR EACH ROW EXECUTE FUNCTION mark_order_courtesy();
CREATE FUNCTION guard_courtesy_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.courtesy_cents<>0 THEN PERFORM integrity_violation('courtesy marker is maintained by ledger'); END IF;
  ELSIF NEW.courtesy_cents IS DISTINCT FROM OLD.courtesy_cents THEN
    IF NEW.courtesy_cents<>(SELECT coalesce(sum(amount_cents),0) FROM order_courtesies WHERE order_id=OLD.id)
      OR OLD.paid_at IS NOT NULL THEN PERFORM integrity_violation('courtesy marker is maintained by ledger'); END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.courtesy_cents>0 AND NEW.status='CANCELADO' THEN
    PERFORM integrity_violation('courtesy orders cannot be cancelled');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_courtesy_marker BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_courtesy_marker();
CREATE FUNCTION guard_courtesy_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  FOREACH target IN ARRAY CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.order_id] WHEN 'DELETE' THEN ARRAY[OLD.order_id] ELSE ARRAY[OLD.order_id,NEW.order_id] END LOOP
    PERFORM id FROM orders WHERE id=target FOR SHARE;
    IF EXISTS(SELECT 1 FROM order_courtesies WHERE order_id=target) THEN PERFORM integrity_violation('courtesy order items are immutable'); END IF;
  END LOOP;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER items_courtesy_guard BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_courtesy_items();

ALTER TABLE payments DROP CONSTRAINT payments_method_check, DROP CONSTRAINT payments_amount_cents_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK(method IN ('EFECTIVO','TARJETA','TRANSFERENCIA','CORTESIA')),
  ADD CONSTRAINT payments_amount_cents_check CHECK((method='CORTESIA' AND amount_cents=0 AND tendered_cents=0 AND change_cents=0) OR (method<>'CORTESIA' AND amount_cents>0));
CREATE OR REPLACE FUNCTION guard_payment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE; s cash_shifts%ROWTYPE;
BEGIN
  SELECT * INTO s FROM cash_shifts WHERE id=NEW.shift_id FOR SHARE;
  IF FOUND AND s.closed_at IS NOT NULL THEN PERFORM integrity_violation('cash shift is closed'); END IF;
  SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF o.status='CANCELADO' THEN PERFORM integrity_violation('cannot charge a cancelled order'); END IF;
  IF NEW.amount_cents<>o.total_cents-o.courtesy_cents THEN PERFORM integrity_violation('payment must equal net order total'); END IF;
  RETURN NEW;
END $$;
