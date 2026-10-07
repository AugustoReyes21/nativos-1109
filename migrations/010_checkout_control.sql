INSERT INTO permissions VALUES ('orders.send_cash'),('cash.close.approve'),('finance.write');
INSERT INTO role_permissions SELECT r.name,p.name FROM roles r CROSS JOIN permissions p
 WHERE r.name IN ('ADMINISTRADOR','SUPERADMIN') AND p.name IN ('orders.send_cash','cash.close.approve','finance.write');
INSERT INTO role_permissions VALUES ('MESERO','orders.send_cash');

ALTER TABLE orders ADD COLUMN sent_to_cash_at timestamptz, ADD COLUMN sent_to_cash_by uuid REFERENCES users(id);
-- Existing uncharged orders are intentionally NOT submitted on behalf of staff.
CREATE INDEX orders_cash_queue ON orders(sent_to_cash_at) WHERE sent_to_cash_at IS NOT NULL AND paid_at IS NULL;
ALTER TABLE orders ADD CONSTRAINT order_cash_submission_pair CHECK((sent_to_cash_at IS NULL)=(sent_to_cash_by IS NULL));

ALTER TABLE payments DROP CONSTRAINT payments_method_check, DROP CONSTRAINT payments_check1;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK(method IN ('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','CORTESIA')),
 ADD CONSTRAINT payments_cash_change CHECK(method IN ('EFECTIVO','MIXTO') OR change_cents=0),
 ADD COLUMN mixed_card_cents integer NOT NULL DEFAULT 0 CHECK(mixed_card_cents>=0),
 ADD COLUMN cash_cents integer GENERATED ALWAYS AS (CASE WHEN method='EFECTIVO' THEN amount_cents WHEN method='MIXTO' THEN amount_cents-mixed_card_cents ELSE 0 END) STORED,
 ADD COLUMN card_cents integer GENERATED ALWAYS AS (CASE WHEN method='TARJETA' THEN amount_cents WHEN method='MIXTO' THEN mixed_card_cents ELSE 0 END) STORED,
 ADD COLUMN transfer_cents integer GENERATED ALWAYS AS (CASE WHEN method='TRANSFERENCIA' THEN amount_cents ELSE 0 END) STORED,
 ADD COLUMN receiver_type text NOT NULL DEFAULT 'CF' CHECK(receiver_type IN ('CF','NIT','CUI')),
 ADD COLUMN receiver_id text NOT NULL DEFAULT 'CF',
 ADD COLUMN receiver_name text NOT NULL DEFAULT 'CONSUMIDOR FINAL' CHECK(length(receiver_name) BETWEEN 1 AND 200),
 ADD COLUMN receiver_address text NOT NULL DEFAULT '' CHECK(length(receiver_address)<=300),
 ADD CONSTRAINT payment_parts CHECK((method='MIXTO' AND mixed_card_cents>0 AND mixed_card_cents<amount_cents) OR (method<>'MIXTO' AND mixed_card_cents=0)),
 ADD CONSTRAINT receiver_identifier CHECK((receiver_type='CF' AND receiver_id='CF') OR (receiver_type='NIT' AND receiver_id ~ '^[0-9]{1,12}[0-9K]$') OR (receiver_type='CUI' AND receiver_id ~ '^[0-9]{13}$'));

ALTER TABLE cash_shifts ADD COLUMN closure_requested_by uuid REFERENCES users(id), ADD COLUMN closure_requested_at timestamptz,
 ADD COLUMN closure_request_id uuid,
 ADD COLUMN closure_counted_cents integer CHECK(closure_counted_cents BETWEEN 0 AND 1000000000), ADD COLUMN closure_approved_by uuid REFERENCES users(id),
 ADD CONSTRAINT closure_request_complete CHECK((closure_request_id IS NULL AND closure_requested_by IS NULL AND closure_requested_at IS NULL AND closure_counted_cents IS NULL) OR (closure_request_id IS NOT NULL AND closure_requested_by IS NOT NULL AND closure_requested_at IS NOT NULL AND closure_counted_cents IS NOT NULL));

CREATE FUNCTION guard_checkout_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s cash_shifts%ROWTYPE; o orders%ROWTYPE;
BEGIN
 SELECT * INTO s FROM cash_shifts WHERE id=NEW.shift_id FOR SHARE;
 IF s.closure_requested_at IS NOT NULL THEN PERFORM integrity_violation('cash closure awaits authorization'); END IF;
 SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF NEW.method<>'CORTESIA' AND o.sent_to_cash_at IS NULL THEN PERFORM integrity_violation('order must be sent to cash'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payments_checkout_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION guard_checkout_payment();
CREATE FUNCTION guard_closure_pending() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s cash_shifts%ROWTYPE;
BEGIN
 SELECT * INTO s FROM cash_shifts WHERE id=NEW.shift_id FOR SHARE;
 IF s.closure_requested_at IS NOT NULL THEN PERFORM integrity_violation('cash closure awaits authorization'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER movements_closure_guard BEFORE INSERT ON cash_movements FOR EACH ROW EXECUTE FUNCTION guard_closure_pending();
CREATE TRIGGER courtesies_closure_guard BEFORE INSERT ON order_courtesies FOR EACH ROW EXECUTE FUNCTION guard_closure_pending();
CREATE FUNCTION guard_closure_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM users u JOIN role_permissions p ON p.role=u.role WHERE u.id=NEW.closure_approved_by AND u.active AND p.permission='cash.close.approve') THEN
   PERFORM integrity_violation('closing cash requires administrative authorization');
  END IF;
  IF OLD.closure_requested_at IS NOT NULL AND NEW.counted_cents<>OLD.closure_counted_cents THEN PERFORM integrity_violation('counted cash differs from authorization request'); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_closure_authorization BEFORE UPDATE ON cash_shifts FOR EACH ROW EXECUTE FUNCTION guard_closure_authorization();

CREATE TABLE receipt_prints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES payments(id), user_id uuid NOT NULL REFERENCES users(id),
 reprint boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipt_prints_payment ON receipt_prints(payment_id,created_at);
CREATE TRIGGER receipt_prints_immutable BEFORE UPDATE OR DELETE ON receipt_prints FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER receipt_prints_no_truncate BEFORE TRUNCATE ON receipt_prints FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TABLE expense_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('GASTO','MERMA')), amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000),
 description text NOT NULL CHECK(length(trim(description)) BETWEEN 3 AND 300), occurred_on date NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_date ON expense_entries(occurred_on,id);
CREATE TRIGGER expenses_immutable BEFORE UPDATE OR DELETE ON expense_entries FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expense_entries FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
