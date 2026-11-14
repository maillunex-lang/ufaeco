-- Органичный растущий город. Только для разработки: прежняя решётчатая карта удаляется и
-- пересоздаётся генератором при старте (живых игровых данных на момент миграции нет).
UPDATE enterprises SET lot_id = NULL WHERE lot_id IS NOT NULL;
DELETE FROM map_lots;
DELETE FROM cities;

ALTER TABLE cities ADD COLUMN center_x integer NOT NULL DEFAULT 0;
ALTER TABLE cities ADD COLUMN center_y integer NOT NULL DEFAULT 0;
ALTER TABLE cities ADD COLUMN population integer NOT NULL DEFAULT 0 CHECK (population >= 0);
ALTER TABLE cities ADD COLUMN housing_cap integer NOT NULL DEFAULT 0;
ALTER TABLE cities ADD COLUMN jobs integer NOT NULL DEFAULT 0;
ALTER TABLE cities ADD COLUMN next_lot_seq integer NOT NULL DEFAULT 1;
ALTER TABLE cities ADD COLUMN growth_day integer NOT NULL DEFAULT 0;

ALTER TABLE map_lots ADD COLUMN base_price_cents bigint NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0);
ALTER TABLE map_lots ADD COLUMN development smallint NOT NULL DEFAULT 0 CHECK (development BETWEEN 0 AND 3);
CREATE INDEX map_lots_city_dev_idx ON map_lots (city_id, development) WHERE owner_company_id IS NULL;
