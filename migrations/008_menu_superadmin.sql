ALTER TABLE roles ADD COLUMN requires_mfa boolean NOT NULL DEFAULT false;
UPDATE roles SET requires_mfa=true WHERE name='ADMINISTRADOR';
INSERT INTO roles(name,requires_mfa) VALUES('SUPERADMIN',true);
INSERT INTO permissions(name) VALUES('roles.superadmin.manage'),('courtesies.create');
INSERT INTO role_permissions SELECT 'SUPERADMIN',name FROM permissions;
INSERT INTO role_permissions VALUES('ADMINISTRADOR','courtesies.create');

ALTER TABLE products ADD COLUMN catalog_code text UNIQUE,
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=1000);

-- Source: MENU NATIVOS.pdf, SHA256 ea1de3015cf78525d41d6a773958ed483958df4b2aefe347d9ec86aa8337ee71.
-- Owner explicitly requested stock 0. This migration never resets stock/prices of existing products.
INSERT INTO categories(name) VALUES('Frappés'),('Smoothies con leche'),('Smoothies enchamolados'),('Especiales'),('Crepas') ON CONFLICT(name) DO NOTHING;
DO $$
DECLARE item record; category uuid; matches integer;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('NAT-FR-MOKA','Frappés','Frappé moka',2500,''),
    ('NAT-FR-OREO','Frappés','Frappé Oreo',3000,''),
    ('NAT-FR-CHOCO','Frappés','Frappé chocolate',2500,''),
    ('NAT-FR-MANIA','Frappés','Frappé mania',3000,''),
    ('NAT-SL-FRESA','Smoothies con leche','Smoothie fresa con leche',3000,'Especial con leche.'),
    ('NAT-SL-MORA','Smoothies con leche','Smoothie mora con leche',3000,'Especial con leche.'),
    ('NAT-SE-FRESA','Smoothies enchamolados','Smoothie fresa enchamolado',3500,''),
    ('NAT-SE-PEPINO','Smoothies enchamolados','Smoothie pepino enchamolado',3500,''),
    ('NAT-SE-PINA','Smoothies enchamolados','Smoothie piña enchamolado',3500,''),
    ('NAT-SE-SANDIA','Smoothies enchamolados','Smoothie sandía enchamolado',3500,''),
    ('NAT-ES-TOSTADA','Especiales','Tostada de tinga de pollo',3500,'Dos tostadas, tinga de pollo, lechuga, crema y cebolla.'),
    ('NAT-ES-PAN','Especiales','Pan con carne',3500,'1 pan con carne de res asada, repollo, zanahoria y chirmol.'),
    ('NAT-ES-TACOS','Especiales','Tacos de birria',4000,'4 tortillas con carne de res, queso mozzarella, cebolla, cilantro y salsa de birria.'),
    ('NAT-ES-HAMB','Especiales','Hamburguesa',4000,'Torta de carne de res, queso, cebolla, tomate, lechuga y papas fritas.'),
    ('NAT-ES-QUESAB','Especiales','Quesabirria',4000,'1 tortilla de harina, carne de res, queso mozzarella, cebolla, cilantro y salsa de birria.'),
    ('NAT-ES-QUESAD','Especiales','Quesadilla de carne asada',4000,'1 tortilla de harina, carne de res, queso mozzarella, cebolla, cilantro y chirmol.'),
    ('NAT-CR-BANANO','Crepas','Crepa de banano',3000,''),
    ('NAT-CR-MIXTA','Crepas','Crepa mixta',3500,''),
    ('NAT-CR-MELOC','Crepas','Crepa de melocotón',3500,''),
    ('NAT-CR-FRESA','Crepas','Crepa de fresa',4000,'')
  ) AS menu(code,category_name,name,price,description) LOOP
    SELECT id INTO category FROM categories WHERE name=item.category_name;
    SELECT count(*) INTO matches FROM products WHERE category_id=category AND name=item.name;
    IF matches>1 THEN RAISE EXCEPTION 'Menu import requires reconciliation of duplicate product names'; END IF;
    IF matches=1 THEN
      UPDATE products SET catalog_code=item.code,description=CASE WHEN description='' THEN item.description ELSE description END
        WHERE category_id=category AND name=item.name AND catalog_code IS NULL;
    ELSE
      INSERT INTO products(category_id,name,price_cents,stock,catalog_code,description)
        VALUES(category,item.name,item.price,0,item.code,item.description) ON CONFLICT(catalog_code) DO NOTHING;
    END IF;
  END LOOP;
END $$;
