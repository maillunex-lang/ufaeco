-- Здания на участках: предприятие может стоять на участке карты (по одному на участок).
ALTER TABLE enterprises ADD COLUMN lot_id text REFERENCES map_lots (id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX enterprises_lot_key ON enterprises (lot_id) WHERE lot_id IS NOT NULL;
