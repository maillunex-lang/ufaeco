-- Этап 2.5: сетка. Клетка — единица земли; здания занимают прямоугольники W×H клеток.
-- Конвертация: участки → клетки в parcels; предприятия на участках → здания; map_lots удаляется.
ALTER TABLE cities ADD COLUMN price_factor real NOT NULL DEFAULT 1 CHECK (price_factor > 0);
ALTER TABLE cities ADD COLUMN grid_version integer NOT NULL DEFAULT 1;

CREATE TABLE parcels (
  city_id          text NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  x                integer NOT NULL CHECK (x >= 0),
  y                integer NOT NULL CHECK (y >= 0),
  owner_company_id uuid NOT NULL REFERENCES companies (id) ON DELETE RESTRICT,
  price_paid_cents bigint NOT NULL CHECK (price_paid_cents >= 0),
  bought_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, x, y)
);
CREATE INDEX parcels_owner_idx ON parcels (owner_company_id);

CREATE TABLE buildings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id          text NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  x                integer NOT NULL CHECK (x >= 0),
  y                integer NOT NULL CHECK (y >= 0),
  w                integer NOT NULL CHECK (w BETWEEN 1 AND 16),
  h                integer NOT NULL CHECK (h BETWEEN 1 AND 16),
  kind             text NOT NULL,
  floors           smallint NOT NULL DEFAULT 1 CHECK (floors BETWEEN 1 AND 40),
  rotated          boolean NOT NULL DEFAULT false,
  owner_company_id uuid REFERENCES companies (id) ON DELETE RESTRICT, -- NULL — городская застройка
  name             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  legacy_enterprise_id uuid
);
CREATE INDEX buildings_city_idx ON buildings (city_id);
CREATE INDEX buildings_owner_idx ON buildings (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER buildings_updated_at BEFORE UPDATE ON buildings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Занятость клеток зданиями: первичный ключ гарантирует отсутствие пересечений на уровне БД.
CREATE TABLE building_cells (
  city_id     text NOT NULL,
  x           integer NOT NULL,
  y           integer NOT NULL,
  building_id uuid NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
  PRIMARY KEY (city_id, x, y)
);
CREATE INDEX building_cells_building_idx ON building_cells (building_id);

ALTER TABLE enterprises ADD COLUMN building_id uuid UNIQUE REFERENCES buildings (id) ON DELETE RESTRICT;

-- Конвертация старых данных (dev): владение участками → клетки.
INSERT INTO parcels (city_id, x, y, owner_company_id, price_paid_cents)
SELECT l.city_id, l.x + dx, l.y + dy, l.owner_company_id, round(l.price_cents::numeric / (l.w * l.h))::bigint
  FROM map_lots l, generate_series(0, 15) dx, generate_series(0, 15) dy
 WHERE l.owner_company_id IS NOT NULL AND dx < l.w AND dy < l.h;

-- Предприятия на участках → здания с габаритами участка.
INSERT INTO buildings (city_id, x, y, w, h, kind, owner_company_id, name, legacy_enterprise_id)
SELECT l.city_id, l.x, l.y, l.w, l.h, e.kind, e.company_id, e.name, e.id
  FROM enterprises e JOIN map_lots l ON l.id = e.lot_id;
UPDATE enterprises e SET building_id = b.id FROM buildings b WHERE b.legacy_enterprise_id = e.id;
INSERT INTO building_cells (city_id, x, y, building_id)
SELECT b.city_id, b.x + dx, b.y + dy, b.id
  FROM buildings b, generate_series(0, 15) dx, generate_series(0, 15) dy
 WHERE b.legacy_enterprise_id IS NOT NULL AND dx < b.w AND dy < b.h;
ALTER TABLE buildings DROP COLUMN legacy_enterprise_id;

DROP INDEX IF EXISTS enterprises_lot_key;
ALTER TABLE enterprises DROP COLUMN lot_id;
DROP TABLE map_lots;
ALTER TABLE cities DROP COLUMN next_lot_seq;
-- Городская застройка (NPC) перегенерируется при старте для городов с grid_version = 1.

-- Экономические графики городов теперь описывают сетку: индекс цен земли, число зданий, клетки в собственности.
ALTER TABLE city_stats_history DROP COLUMN land_index, DROP COLUMN traffic_index, DROP COLUMN built_share, DROP COLUMN lots;
ALTER TABLE city_stats_history ADD COLUMN price_index integer NOT NULL DEFAULT 100;
ALTER TABLE city_stats_history ADD COLUMN housing_cap integer NOT NULL DEFAULT 0;
ALTER TABLE city_stats_history ADD COLUMN buildings integer NOT NULL DEFAULT 0;
ALTER TABLE city_stats_history ADD COLUMN owned_cells integer NOT NULL DEFAULT 0;
