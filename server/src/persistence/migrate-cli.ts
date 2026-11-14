import { loadConfig } from '../config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет');
} finally {
  await db.end();
}
