import pg from 'pg';

export type Db = pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** BEGIN/COMMIT; при любой ошибке — ROLLBACK, клиент всегда возвращается в пул. */
export async function withTransaction<T>(db: Db, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* соединение уже сломано — оно будет отброшено пулом */
    }
    throw err;
  } finally {
    client.release();
  }
}
