CREATE TABLE roles (name text PRIMARY KEY);
CREATE TABLE permissions (name text PRIMARY KEY);
CREATE TABLE role_permissions (
  role text REFERENCES roles(name), permission text REFERENCES permissions(name), PRIMARY KEY(role, permission)
);
INSERT INTO roles VALUES ('ADMINISTRADOR'), ('CAJERO'), ('MESERO'), ('COCINA');
INSERT INTO permissions VALUES ('products.read'), ('products.write'), ('orders.read'), ('orders.create'),
 ('orders.update'), ('orders.cancel'), ('kitchen.update'), ('payments.create'), ('cash.open'), ('cash.close'),
 ('cash.read'), ('cash.move'), ('users.manage'), ('reports.read'), ('settings.manage'), ('audit.read');
INSERT INTO role_permissions SELECT 'ADMINISTRADOR', name FROM permissions;
INSERT INTO role_permissions SELECT 'CAJERO', name FROM permissions WHERE name IN
 ('products.read','orders.read','orders.cancel','payments.create','cash.open','cash.close','cash.read','cash.move');
INSERT INTO role_permissions SELECT 'MESERO', name FROM permissions WHERE name IN
 ('products.read','orders.read','orders.create','orders.update');
INSERT INTO role_permissions VALUES ('COCINA','orders.read'), ('COCINA','kitchen.update');

CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL CHECK(email=lower(email)),
 name text NOT NULL, password_hash text NOT NULL, role text NOT NULL REFERENCES roles(name),
 active boolean NOT NULL DEFAULT true, mfa_secret text, mfa_enabled boolean NOT NULL DEFAULT false,
 mfa_last_step bigint NOT NULL DEFAULT -1, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT mfa_enabled OR mfa_secret IS NOT NULL)
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE refresh_tokens (
 hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id), used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_session ON refresh_tokens(session_id);
CREATE TABLE auth_challenges (
 hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK(purpose IN ('LOGIN','SETUP')),
 pending_secret text, expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE recovery_codes (user_id uuid REFERENCES users(id), hash text NOT NULL, PRIMARY KEY(user_id,hash));
CREATE TABLE password_resets (
 hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE rate_limits (key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL);

CREATE TABLE categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL);
CREATE TABLE products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id uuid NOT NULL REFERENCES categories(id),
 name text NOT NULL, price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 10000000),
 stock integer NOT NULL DEFAULT 0 CHECK(stock BETWEEN 0 AND 1000000), active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category ON products(category_id);
CREATE TABLE restaurant_tables (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE restaurant_settings (
 id integer PRIMARY KEY CHECK(id=1), name text NOT NULL, currency text NOT NULL CHECK(currency='GTQ'),
 timezone text NOT NULL CHECK(timezone='America/Guatemala')
);
INSERT INTO restaurant_settings VALUES (1, 'Nativos1109', 'GTQ', 'America/Guatemala');
CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 table_id uuid NOT NULL REFERENCES restaurant_tables(id), user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'PENDIENTE' CHECK(status IN ('PENDIENTE','EN_PREPARACION','LISTO','ENTREGADO','CANCELADO')),
 total_cents integer NOT NULL CHECK(total_cents BETWEEN 1 AND 1000000000), version integer NOT NULL DEFAULT 1,
 notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_created ON orders(status,created_at);
CREATE INDEX orders_owner ON orders(user_id,created_at);
CREATE INDEX orders_table ON orders(table_id);
CREATE TABLE order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
 product_id uuid NOT NULL REFERENCES products(id), name text NOT NULL, quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
 price_cents integer NOT NULL CHECK(price_cents>0), notes text NOT NULL DEFAULT '', UNIQUE(order_id,product_id)
);
CREATE TABLE cash_shifts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 opening_cents integer NOT NULL CHECK(opening_cents BETWEEN 0 AND 1000000000), counted_cents integer CHECK(counted_cents>=0),
 expected_cents bigint, difference_cents bigint, opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 CHECK((closed_at IS NULL AND counted_cents IS NULL) OR (closed_at IS NOT NULL AND counted_cents IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_register ON cash_shifts ((true)) WHERE closed_at IS NULL;
CREATE TABLE payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 shift_id uuid NOT NULL REFERENCES cash_shifts(id), user_id uuid NOT NULL REFERENCES users(id),
 method text NOT NULL CHECK(method IN ('EFECTIVO','TARJETA','TRANSFERENCIA')),
 amount_cents integer NOT NULL CHECK(amount_cents>0), tendered_cents integer NOT NULL,
 change_cents integer NOT NULL CHECK(change_cents>=0), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(tendered_cents=amount_cents+change_cents), CHECK(method='EFECTIVO' OR change_cents=0)
);
CREATE INDEX payments_shift ON payments(shift_id);
CREATE INDEX payments_created ON payments(created_at);
CREATE TABLE cash_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shift_id uuid NOT NULL REFERENCES cash_shifts(id),
 user_id uuid NOT NULL REFERENCES users(id), amount_cents integer NOT NULL CHECK(amount_cents<>0 AND abs(amount_cents)<=1000000000),
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX movements_shift ON cash_movements(shift_id);
CREATE TABLE idempotency (
 user_id uuid REFERENCES users(id), key uuid NOT NULL, operation text NOT NULL, request_hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
CREATE TABLE audit_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES users(id),
 action text NOT NULL, resource text NOT NULL, resource_id text, result text NOT NULL,
 request_id text NOT NULL, ip text, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created ON audit_log(created_at);
CREATE TABLE events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
