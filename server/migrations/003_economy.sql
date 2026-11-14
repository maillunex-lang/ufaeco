-- Этап 3: общая экономика (цены, NPC-компании, кредиты, банкротства, экономические дни).

ALTER TABLE companies ALTER COLUMN owner_player_id DROP NOT NULL;
ALTER TABLE companies ADD COLUMN is_npc boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'bankrupt'));
ALTER TABLE companies ADD COLUMN missed_wage_days integer NOT NULL DEFAULT 0 CHECK (missed_wage_days >= 0);
ALTER TABLE companies ADD COLUMN insolvent_days integer NOT NULL DEFAULT 0 CHECK (insolvent_days >= 0);
ALTER TABLE companies ADD COLUMN bankrupt_day integer;
ALTER TABLE companies ADD CONSTRAINT companies_npc_owner CHECK (is_npc = (owner_player_id IS NULL));
CREATE INDEX companies_status_idx ON companies (status) WHERE NOT is_npc;

CREATE TABLE market_prices (
  product_id       text PRIMARY KEY,
  base_price_cents bigint NOT NULL CHECK (base_price_cents > 0),
  price_cents      bigint NOT NULL CHECK (price_cents > 0),
  supply_today     bigint NOT NULL DEFAULT 0 CHECK (supply_today >= 0),
  demand_today     bigint NOT NULL DEFAULT 0 CHECK (demand_today >= 0),
  last_supply      bigint NOT NULL DEFAULT 0,
  last_demand      bigint NOT NULL DEFAULT 0,
  updated_day      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER market_prices_updated_at BEFORE UPDATE ON market_prices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE economy_days (
  day         integer PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE loans (
  company_id    uuid PRIMARY KEY REFERENCES companies (id) ON DELETE CASCADE,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER loans_updated_at BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
