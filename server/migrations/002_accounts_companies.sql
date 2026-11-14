-- Этап 2: аккаунты (логин/пароль), журнал операций, инвентарь, предприятия.

ALTER TABLE players ADD COLUMN login text;
ALTER TABLE players ADD COLUMN password_hash text;
ALTER TABLE players ADD CONSTRAINT players_login_format CHECK (login IS NULL OR login ~ '^[A-Za-z0-9_]{3,24}$');
ALTER TABLE players ADD CONSTRAINT players_login_has_password CHECK ((login IS NULL) = (password_hash IS NULL));
CREATE UNIQUE INDEX players_login_lower_key ON players (lower(login)) WHERE login IS NOT NULL;

-- Журнал операций по балансу компании (только добавление записей).
CREATE TABLE ledger_entries (
  id                  bigserial PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE RESTRICT,
  player_id           uuid REFERENCES players (id) ON DELETE SET NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents <> 0),
  balance_after_cents bigint NOT NULL CHECK (balance_after_cents >= 0),
  reason              text NOT NULL,
  details             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_company_idx ON ledger_entries (company_id, id);

CREATE TABLE inventory_items (
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  product_id text NOT NULL,
  quantity   bigint NOT NULL CHECK (quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, product_id)
);
CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE enterprises (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE RESTRICT,
  kind       text NOT NULL,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX enterprises_company_name_key ON enterprises (company_id, lower(name));
CREATE INDEX enterprises_company_idx ON enterprises (company_id);
CREATE TRIGGER enterprises_updated_at BEFORE UPDATE ON enterprises FOR EACH ROW EXECUTE FUNCTION set_updated_at();
