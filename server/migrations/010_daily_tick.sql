-- Переход на суточный шаг (игровой день = 1 реальный час, месяц = 24 дня). Прежние недельные номера тиков теряют смысл,
-- поэтому часы миров и производные истории сбрасываются (только dev: боевых миров ещё нет).
DELETE FROM city_stats_history;
DELETE FROM world_clock; -- каскадом удаляет world_ticks
ALTER TABLE world_ticks ADD COLUMN day smallint NOT NULL DEFAULT 1 CHECK (day BETWEEN 1 AND 24);
