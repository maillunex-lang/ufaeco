import { randomInt } from 'node:crypto';
import type { Queryable } from '../persistence/db.js';

export interface Player {
  id: string;
  displayName: string;
}

/** Этап 1: только гостевые игроки. Регистрация и авторизация по паролю — этап 2. */
export class AccountService {
  async createGuestPlayer(q: Queryable, displayName?: string): Promise<Player> {
    const name = displayName ?? `Игрок-${randomInt(1000, 10000)}`;
    const r = await q.query<{ id: string; display_name: string }>(
      'INSERT INTO players (display_name) VALUES ($1) RETURNING id, display_name',
      [name],
    );
    const row = r.rows[0]!;
    return { id: row.id, displayName: row.display_name };
  }

  async getPlayer(q: Queryable, id: string): Promise<Player | null> {
    const r = await q.query<{ id: string; display_name: string; status: string }>(
      'SELECT id, display_name, status FROM players WHERE id = $1',
      [id],
    );
    const row = r.rows[0];
    return row && row.status === 'active' ? { id: row.id, displayName: row.display_name } : null;
  }

  async setDisplayName(q: Queryable, id: string, name: string): Promise<void> {
    await q.query('UPDATE players SET display_name = $2 WHERE id = $1', [id, name]);
  }
}
