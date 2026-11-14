-- Минимальная схема этапа 1. Применяется раннером в одной транзакции.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE players (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 32),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_created_at_idx ON players (created_at);

CREATE TABLE sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  resume_token_hash text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'closed')),
  client_info       jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  disconnected_at   timestamptz,
  expires_at        timestamptz,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_resume_token_hash_key UNIQUE (resume_token_hash)
);
CREATE INDEX sessions_player_id_idx ON sessions (player_id);
CREATE INDEX sessions_status_expires_idx ON sessions (status, expires_at);

-- Таблица подготовлена для этапа 2; в этапе 1 функциональности компаний нет.
CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id uuid NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 64),
  balance_cents   bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name_lower_key ON companies (lower(name));
CREATE INDEX companies_owner_idx ON companies (owner_player_id);

CREATE TABLE idempotency_requests (
  id           bigserial PRIMARY KEY,
  player_id    uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  request_id   uuid NOT NULL,
  command_name text NOT NULL,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_player_request_key UNIQUE (player_id, request_id)
);
CREATE INDEX idempotency_created_at_idx ON idempotency_requests (created_at);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  player_id  uuid REFERENCES players (id) ON DELETE SET NULL,
  session_id uuid,
  event_type text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_player_created_idx ON audit_log (player_id, created_at);
CREATE INDEX audit_log_event_created_idx ON audit_log (event_type, created_at);

CREATE TRIGGER players_updated_at BEFORE UPDATE ON players FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER idempotency_updated_at BEFORE UPDATE ON idempotency_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER audit_log_updated_at BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION set_updated_at();
