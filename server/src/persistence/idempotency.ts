import { createHash } from 'node:crypto';
import type { Db, Queryable } from './db.js';
import { withTransaction } from './db.js';

export function hashRequest(name: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify([name, args])).digest('hex');
}

export type IdempotentOutcome =
  | { kind: 'executed'; response: Record<string, unknown> }
  | { kind: 'duplicate'; response: Record<string, unknown> }
  | { kind: 'conflict' };

/**
 * Выполняет операцию не более одного раза на (player_id, request_id).
 * Резервирование request_id, выполнение handler и сохранение ответа — в одной транзакции:
 * при ошибке handler откатывается всё, включая резерв, и запрос можно повторить.
 * Параллельный дубль ждёт коммита первого (ON CONFLICT) и получает сохранённый ответ.
 */
export async function executeOnce(
  db: Db,
  p: { playerId: string; requestId: string; commandName: string; requestHash: string },
  handler: (tx: Queryable) => Promise<Record<string, unknown>>,
): Promise<IdempotentOutcome> {
  return withTransaction(db, async (tx) => {
    const ins = await tx.query(
      `INSERT INTO idempotency_requests (player_id, request_id, command_name, request_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT (player_id, request_id) DO NOTHING RETURNING id`,
      [p.playerId, p.requestId, p.commandName, p.requestHash],
    );
    if (ins.rowCount === 0) {
      const row = (
        await tx.query<{ request_hash: string; response: Record<string, unknown> | null }>(
          'SELECT request_hash, response FROM idempotency_requests WHERE player_id = $1 AND request_id = $2',
          [p.playerId, p.requestId],
        )
      ).rows[0];
      if (!row || row.request_hash !== p.requestHash) return { kind: 'conflict' as const };
      return { kind: 'duplicate' as const, response: row.response ?? {} };
    }
    const response = await handler(tx);
    await tx.query('UPDATE idempotency_requests SET response = $3 WHERE player_id = $1 AND request_id = $2', [
      p.playerId,
      p.requestId,
      JSON.stringify(response),
    ]);
    return { kind: 'executed' as const, response };
  });
}
