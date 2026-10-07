-- Existing history can only be backfilled from today's table metadata.
-- Transactional migration; the guard is re-enabled before commit and no business
-- values are changed. New orders preserve their original table label and floor.
ALTER TABLE orders ADD COLUMN table_name text, ADD COLUMN table_floor smallint;
ALTER TABLE orders DISABLE TRIGGER orders_guard_update;
UPDATE orders o SET table_name=t.name,table_floor=t.floor FROM restaurant_tables t WHERE t.id=o.table_id;
ALTER TABLE orders ENABLE TRIGGER orders_guard_update;
ALTER TABLE orders ALTER COLUMN table_name SET NOT NULL,
  ALTER COLUMN table_floor SET NOT NULL,
  ADD CONSTRAINT orders_table_floor CHECK(table_floor IN (1,2));

CREATE FUNCTION snapshot_order_table() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT name,floor INTO NEW.table_name,NEW.table_floor FROM restaurant_tables WHERE id=NEW.table_id FOR SHARE;
  ELSIF NEW.table_id IS DISTINCT FROM OLD.table_id OR NEW.table_name IS DISTINCT FROM OLD.table_name
     OR NEW.table_floor IS DISTINCT FROM OLD.table_floor THEN
    PERFORM integrity_violation('order table snapshot is immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_table_snapshot BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION snapshot_order_table();
