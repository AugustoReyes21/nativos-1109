-- A refresh retry must present the SAME operation key and old token; arbitrary
-- replay still revokes the family. Cached replacement is encrypted, never plain.
ALTER TABLE refresh_tokens ADD COLUMN retry_key_hash text;
ALTER TABLE refresh_tokens ADD COLUMN replacement_encrypted text;
ALTER TABLE audit_log ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX audit_resource ON audit_log(resource,resource_id,id);

-- Follow-up to Claude's 002: lock an OPEN shift too, otherwise a movement
-- racing with close can slip through the closed-only predicate.
CREATE OR REPLACE FUNCTION guard_cash_movement_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closed timestamptz;
BEGIN
  SELECT closed_at INTO closed FROM cash_shifts WHERE id=NEW.shift_id FOR SHARE;
  IF FOUND AND closed IS NOT NULL THEN PERFORM integrity_violation('cash shift is closed'); END IF;
  RETURN NEW;
END $$;
