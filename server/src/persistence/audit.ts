import type { Queryable } from './db.js';

export interface AuditEntry {
  playerId?: string | null;
  sessionId?: string | null;
  eventType: string;
  details?: Record<string, unknown>;
}

export async function writeAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query('INSERT INTO audit_log (player_id, session_id, event_type, details) VALUES ($1, $2, $3, $4)', [
    e.playerId ?? null,
    e.sessionId ?? null,
    e.eventType,
    JSON.stringify(e.details ?? {}),
  ]);
}
