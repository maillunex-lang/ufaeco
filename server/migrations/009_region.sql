-- Этап 2: регион РБ. Аддитивная миграция (данные не удаляются).
ALTER TABLE cities ADD COLUMN lat double precision;
ALTER TABLE cities ADD COLUMN lon double precision;
ALTER TABLE cities ADD COLUMN wage_rub integer;
ALTER TABLE cities ADD COLUMN land_base_cents bigint;
ALTER TABLE cities ADD COLUMN farmland_index real;
ALTER TABLE cities ADD COLUMN specialization jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE cities ADD COLUMN has_river boolean NOT NULL DEFAULT true;
ALTER TABLE cities ADD COLUMN capacity_per_tile real NOT NULL DEFAULT 4 CHECK (capacity_per_tile > 0);
ALTER TABLE cities ADD COLUMN base_population integer NOT NULL DEFAULT 2000 CHECK (base_population > 0);

ALTER TABLE map_lots ADD COLUMN land_value smallint NOT NULL DEFAULT 0 CHECK (land_value BETWEEN 0 AND 100);
ALTER TABLE map_lots ADD COLUMN traffic smallint NOT NULL DEFAULT 0 CHECK (traffic BETWEEN 0 AND 100);

-- Месторождения и участки сырья: игроки смогут получать их в собственность (этап 5).
CREATE TABLE resource_sites (
  id               text PRIMARY KEY,
  resource         text NOT NULL,
  name             text NOT NULL,
  lat              double precision NOT NULL,
  lon              double precision NOT NULL,
  city_id          text NOT NULL REFERENCES cities (id) ON DELETE RESTRICT,
  reserve_units    bigint NOT NULL CHECK (reserve_units > 0),
  remaining_units  bigint NOT NULL CHECK (remaining_units >= 0),
  quality          smallint NOT NULL CHECK (quality BETWEEN 1 AND 100),
  owner_company_id uuid REFERENCES companies (id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_sites_resource_idx ON resource_sites (resource);
CREATE INDEX resource_sites_city_idx ON resource_sites (city_id);
CREATE TRIGGER resource_sites_updated_at BEFORE UPDATE ON resource_sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Логистические хабы (аналог «портов» Capitalism): внешний рынок.
CREATE TABLE hubs (
  id         text PRIMARY KEY,
  city_id    text NOT NULL REFERENCES cities (id) ON DELETE RESTRICT,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('industrial', 'commercial', 'mixed')),
  gateway    text NOT NULL CHECK (gateway IN ('west', 'east', 'north', 'south')),
  gateway_km real NOT NULL CHECK (gateway_km > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER hubs_updated_at BEFORE UPDATE ON hubs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Экономические графики городов: одна запись на игровой месяц.
CREATE TABLE city_stats_history (
  city_id     text NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  month_index integer NOT NULL,
  year        integer NOT NULL,
  month       integer NOT NULL,
  population  integer NOT NULL,
  wage_rub    integer NOT NULL,
  land_index  integer NOT NULL,
  traffic_index integer NOT NULL,
  built_share real NOT NULL,
  lots        integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, month_index)
);
