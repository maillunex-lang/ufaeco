-- Этап 1: часы мира и журнал недельных тиков. Старый «экономический день» удаляется (этап 3 прототипа заменяется механиками Capitalism).
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS market_prices;
DROP TABLE IF EXISTS economy_days;

CREATE TABLE world_clock (
  world_id    text PRIMARY KEY,
  epoch       timestamptz NOT NULL,
  speed       numeric NOT NULL DEFAULT 1 CHECK (speed > 0),
  start_year  integer NOT NULL,
  start_month integer NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  seed        integer NOT NULL,
  last_tick   bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER world_clock_updated_at BEFORE UPDATE ON world_clock FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE world_ticks (
  world_id    text NOT NULL REFERENCES world_clock (world_id) ON DELETE CASCADE,
  tick        bigint NOT NULL,
  week        integer NOT NULL CHECK (week BETWEEN 1 AND 4),
  month_index integer NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (world_id, tick)
);
