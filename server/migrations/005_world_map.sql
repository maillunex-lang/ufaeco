-- Карта мира: города и участки земли.
CREATE TABLE cities (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  seed       integer NOT NULL,
  width      integer NOT NULL CHECK (width > 0),
  height     integer NOT NULL CHECK (height > 0),
  tiles      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cities_updated_at BEFORE UPDATE ON cities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE map_lots (
  id               text PRIMARY KEY,
  city_id          text NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  x                integer NOT NULL,
  y                integer NOT NULL,
  w                integer NOT NULL CHECK (w > 0),
  h                integer NOT NULL CHECK (h > 0),
  zone             text NOT NULL CHECK (zone IN ('residential', 'commercial', 'industrial', 'park')),
  price_cents      bigint NOT NULL CHECK (price_cents >= 0),
  owner_company_id uuid REFERENCES companies (id) ON DELETE RESTRICT,
  bought_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT map_lots_position_key UNIQUE (city_id, x, y),
  CONSTRAINT map_lots_park_unowned CHECK (zone <> 'park' OR owner_company_id IS NULL)
);
CREATE INDEX map_lots_city_idx ON map_lots (city_id);
CREATE INDEX map_lots_owner_idx ON map_lots (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER map_lots_updated_at BEFORE UPDATE ON map_lots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
