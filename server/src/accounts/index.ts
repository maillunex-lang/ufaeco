import { randomInt } from 'node:crypto';
import { DomainError } from '../errors.js';
import type { Queryable } from '../persistence/db.js';
import { hashPassword, verifyPassword } from '../security/password.js';

export interface Player {
  id: string;
  displayName: string;
  login: string | null;
}

interface Row {
  id: string;
  display_name: string;
  login: string | null;
  status?: string;
}
const toPlayer = (r: Row): Player => ({ id: r.id, displayName: r.display_name, login: r.login });

export class AccountService {
  async createGuestPlayer(q: Queryable, displayName?: string): Promise<Player> {
    const name = displayName ?? `Игрок-${randomInt(1000, 10000)}`;
    const r = await q.query<Row>('INSERT INTO players (display_name) VALUES ($1) RETURNING id, display_name, login', [name]);
    return toPlayer(r.rows[0]!);
  }

  /** Регистрация по логину и паролю. Пароль хранится только как salted scrypt-хэш. */
  async register(q: Queryable, login: string, password: string, displayName?: string): Promise<Player> {
    const hash = await hashPassword(password);
    try {
      const r = await q.query<Row>(
        'INSERT INTO players (display_name, login, password_hash) VALUES ($1, $2, $3) RETURNING id, display_name, login',
        [displayName ?? login, login, hash],
      );
      return toPlayer(r.rows[0]!);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DomainError('login_taken');
      throw e;
    }
  }

  /** Возвращает игрока при верном пароле, иначе null (причина неверных данных не раскрывается). */
  async authenticate(q: Queryable, login: string, password: string): Promise<Player | null> {
    const r = await q.query<Row & { password_hash: string }>(
      'SELECT id, display_name, login, status, password_hash FROM players WHERE lower(login) = lower($1)',
      [login],
    );
    const row = r.rows[0];
    const ok = await verifyPassword(password, row?.password_hash ?? null);
    return ok && row && row.status === 'active' ? toPlayer(row) : null;
  }

  async getPlayer(q: Queryable, id: string): Promise<Player | null> {
    const r = await q.query<Row>('SELECT id, display_name, login, status FROM players WHERE id = $1', [id]);
    const row = r.rows[0];
    return row && row.status === 'active' ? toPlayer(row) : null;
  }

  async setDisplayName(q: Queryable, id: string, name: string): Promise<void> {
    await q.query('UPDATE players SET display_name = $2 WHERE id = $1', [id, name]);
  }
}
