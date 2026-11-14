import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { executeOnce, hashRequest } from '../src/persistence/idempotency.js';
import { TEST_DB_URL } from './helpers.js';

let db: Db;
beforeAll(() => {
  db = createPool(TEST_DB_URL);
});
afterAll(async () => {
  await db.end();
});

describe('PostgreSQL', () => {
  it('13. миграции применяются, схема содержит нужные таблицы, индексы и ограничения', async () => {
    await runMigrations(db);
    const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
    for (const t of ['players', 'sessions', 'companies', 'idempotency_requests', 'audit_log', 'schema_migrations']) expect(tables).toContain(t);
    const idx = (await db.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map((r) => r.indexname);
    for (const i of ['sessions_player_id_idx', 'audit_log_player_created_idx', 'idempotency_player_request_key', 'sessions_resume_token_hash_key', 'companies_name_lower_key'])
      expect(idx).toContain(i);
    const cols = (await db.query("SELECT table_name, column_name FROM information_schema.columns WHERE column_name IN ('created_at','updated_at') AND table_schema='public'")).rows;
    for (const t of ['players', 'sessions', 'companies', 'idempotency_requests', 'audit_log']) {
      expect(cols.filter((c) => c.table_name === t).map((c) => c.column_name).sort()).toEqual(['created_at', 'updated_at']);
    }
  });

  it('14. повторный запуск миграций не портит данные', async () => {
    const p = (await db.query("INSERT INTO players (display_name) VALUES ('Сохранность') RETURNING id")).rows[0].id;
    expect(await runMigrations(db)).toEqual([]);
    expect(await runMigrations(db)).toEqual([]);
    const r = await db.query('SELECT display_name FROM players WHERE id = $1', [p]);
    expect(r.rows[0].display_name).toBe('Сохранность');
    await db.query('DELETE FROM players WHERE id = $1', [p]);
  });

  it('параллельный запуск миграций безопасен', async () => {
    const results = await Promise.all([runMigrations(db), runMigrations(db), runMigrations(db)]);
    expect(results.flat()).toEqual([]);
  });

  it('ограничения: баланс компании не отрицателен, имя уникально, updated_at обновляется', async () => {
    const pid = (await db.query("INSERT INTO players (display_name) VALUES ('Владелец') RETURNING id")).rows[0].id;
    const name = `Компания-${randomUUID().slice(0, 8)}`;
    await db.query('INSERT INTO companies (owner_player_id, name) VALUES ($1, $2)', [pid, name]);
    await expect(db.query('INSERT INTO companies (owner_player_id, name) VALUES ($1, $2)', [pid, name.toUpperCase()])).rejects.toThrow(/companies_name_lower_key/);
    await expect(db.query('UPDATE companies SET balance_cents = -1 WHERE owner_player_id = $1', [pid])).rejects.toThrow(/check/i);
    const before = (await db.query('SELECT updated_at FROM players WHERE id = $1', [pid])).rows[0].updated_at as Date;
    await new Promise((r) => setTimeout(r, 20));
    await db.query("UPDATE players SET display_name = 'Владелец 2' WHERE id = $1", [pid]);
    const after = (await db.query('SELECT updated_at FROM players WHERE id = $1', [pid])).rows[0].updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    await db.query('DELETE FROM companies WHERE owner_player_id = $1', [pid]);
    await db.query('DELETE FROM players WHERE id = $1', [pid]);
  });

  it('executeOnce откатывает резерв request_id при ошибке handler', async () => {
    const pid = (await db.query("INSERT INTO players (display_name) VALUES ('Транзакция') RETURNING id")).rows[0].id;
    const requestId = randomUUID();
    const p = { playerId: pid, requestId, commandName: 'x', requestHash: hashRequest('x', {}) };
    await expect(executeOnce(db, p, async () => { throw new Error('сбой'); })).rejects.toThrow('сбой');
    expect((await db.query('SELECT count(*)::int n FROM idempotency_requests WHERE request_id = $1', [requestId])).rows[0].n).toBe(0);
    const ok = await executeOnce(db, p, async () => ({ ok: true }));
    expect(ok.kind).toBe('executed');
    const dup = await executeOnce(db, p, async () => { throw new Error('не должно выполняться'); });
    expect(dup.kind).toBe('duplicate');
    await db.query('DELETE FROM players WHERE id = $1', [pid]);
  });
});
