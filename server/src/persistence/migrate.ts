import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Db } from './db.js';
import { withTransaction } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const LOCK_KEY = 727_001; // advisory lock: миграции не запускаются параллельно

/** Применяет ещё не применённые миграции; повторный запуск безопасен. Возвращает имена применённых. */
export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set((await tx.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.query(readFileSync(join(dir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    }
  });
  return applied;
}
