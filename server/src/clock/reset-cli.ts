import { loadConfig } from '../config.js';
import { createPool } from '../persistence/db.js';

/** Dev-инструмент: удаляет часы и журнал тиков мира WORLD_ID (мир стартует заново). Запрещено в production. */
const config = loadConfig();
if (config.environment === 'production') {
  console.error('Сброс мира запрещён в production');
  process.exit(1);
}
const db = createPool(config.databaseUrl);
try {
  const r = await db.query('DELETE FROM world_clock WHERE world_id = $1', [config.worldId]);
  console.log(r.rowCount ? `Часы мира «${config.worldId}» сброшены` : `Мир «${config.worldId}» не найден`);
} finally {
  await db.end();
}
