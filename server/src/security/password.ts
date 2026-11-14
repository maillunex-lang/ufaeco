import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;
const COST = 16384;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: COST }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${COST}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // При отсутствии пользователя всё равно считаем хэш, чтобы не выдавать существование логина по времени.
  const parts = (stored ?? '').split('$');
  const salt = parts[0] === 'scrypt' && parts[2] ? Buffer.from(parts[2], 'base64') : Buffer.alloc(16);
  const expected = parts[0] === 'scrypt' && parts[3] ? Buffer.from(parts[3], 'base64') : Buffer.alloc(KEYLEN);
  const actual = await derive(password, salt);
  return stored !== null && expected.length === actual.length && timingSafeEqual(expected, actual);
}
