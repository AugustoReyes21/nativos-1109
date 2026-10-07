-- 004 is reserved for Claude's paid-order marker (PR #4). Independent migration.
ALTER TABLE restaurant_tables
  ADD COLUMN floor smallint NOT NULL DEFAULT 1 CHECK (floor IN (1,2)),
  ADD COLUMN capacity smallint NOT NULL DEFAULT 4 CHECK (capacity BETWEEN 1 AND 12),
  ADD COLUMN shape text NOT NULL DEFAULT 'square' CHECK (shape IN ('square','round','rectangle')),
  ADD COLUMN display_order integer NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 999),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE INDEX restaurant_tables_floor ON restaurant_tables(floor,display_order,name) WHERE active;
