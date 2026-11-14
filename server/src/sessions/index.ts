import type { Queryable } from '../persistence/db.js';
import { hashToken, newResumeToken } from '../security/tokens.js';

export type ResumeResult =
  | { ok: true; sessionId: string; playerId: string; token: string }
  | { ok: false; code: 'invalid_session' | 'session_expired' };

export class SessionService {
  constructor(private readonly reconnectTimeoutS: number) {}

  async create(q: Queryable, playerId: string, clientInfo: Record<string, unknown>) {
    const { token, hash } = newResumeToken();
    const r = await q.query<{ id: string }>(
      'INSERT INTO sessions (player_id, resume_token_hash, client_info) VALUES ($1, $2, $3) RETURNING id',
      [playerId, hash, JSON.stringify(clientInfo)],
    );
    return { sessionId: r.rows[0]!.id, token };
  }

  /** Проверяет токен и просрочку; при успехе выдаёт НОВЫЙ resume_token (ротация), старый перестаёт работать. */
  async resume(q: Queryable, sessionId: string, token: string): Promise<ResumeResult> {
    const r = await q.query<{ id: string; player_id: string; status: string; expired: boolean }>(
      `SELECT id, player_id, status, (expires_at IS NOT NULL AND expires_at < now()) AS expired
         FROM sessions WHERE id = $1 AND resume_token_hash = $2 FOR UPDATE`,
      [sessionId, hashToken(token)],
    );
    const row = r.rows[0];
    if (!row || row.status === 'closed') return { ok: false, code: 'invalid_session' };
    if (row.status === 'disconnected' && row.expired) {
      await q.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [sessionId]);
      return { ok: false, code: 'session_expired' };
    }
    const fresh = newResumeToken();
    await q.query(
      `UPDATE sessions SET status = 'active', resume_token_hash = $2, connected_at = now(),
              last_seen_at = now(), disconnected_at = NULL, expires_at = NULL WHERE id = $1`,
      [sessionId, fresh.hash],
    );
    return { ok: true, sessionId, playerId: row.player_id, token: fresh.token };
  }

  async markDisconnected(q: Queryable, sessionId: string): Promise<void> {
    await q.query(
      `UPDATE sessions SET status = 'disconnected', disconnected_at = now(), last_seen_at = now(),
              expires_at = now() + make_interval(secs => $2)
        WHERE id = $1 AND status = 'active'`,
      [sessionId, this.reconnectTimeoutS],
    );
  }

  async close(q: Queryable, sessionId: string): Promise<void> {
    await q.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [sessionId]);
  }

  /** После рестарта сервера «active» сессий без сокетов быть не может: даём им окно на reconnect. */
  async markAllActiveDisconnected(q: Queryable): Promise<number> {
    const r = await q.query(
      `UPDATE sessions SET status = 'disconnected', disconnected_at = now(),
              expires_at = now() + make_interval(secs => $1) WHERE status = 'active'`,
      [this.reconnectTimeoutS],
    );
    return r.rowCount ?? 0;
  }

  async closeExpired(q: Queryable): Promise<number> {
    const r = await q.query(
      "UPDATE sessions SET status = 'closed' WHERE status = 'disconnected' AND expires_at < now()",
    );
    return r.rowCount ?? 0;
  }
}
