import { createHash, randomBytes } from 'node:crypto';

/** Секрет возобновления сессии: клиенту отдаётся токен, в БД хранится только sha256. */
export function newResumeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
