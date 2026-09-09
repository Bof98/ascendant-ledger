import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db/connection.js';
import type { AppConfig } from './config/env.js';
import { nowIso } from './domain/time.js';

interface SessionPayload {
  uid: number;
  username: string;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, expectedHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function ensureInitialUser(db: Db, config: AppConfig): void {
  if (!config.AUTH_ENABLED) return;
  const count = Number((db.prepare('SELECT COUNT(*) AS c FROM app_users').get() as { c: number }).c);
  if (count > 0) return;
  if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) {
    throw new Error(
      'AUTH_ENABLED=true requires ADMIN_USERNAME and ADMIN_PASSWORD on first boot. ' +
        'Use a strong password and expose the service only through HTTPS.',
    );
  }
  db.prepare(
    `INSERT INTO app_users (username, password_hash, created_at, last_login_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(config.ADMIN_USERNAME, hashPassword(config.ADMIN_PASSWORD), nowIso());
}

function parseCookies(request: FastifyRequest): Record<string, string> {
  const raw = request.headers.cookie ?? '';
  const cookies: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function createSessionCookie(user: { id: number; username: string }, secret: string): string {
  const payload: SessionPayload = {
    uid: user.id,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function readSession(request: FastifyRequest, secret: string): SessionPayload | null {
  const token = parseCookies(request)['ledger_session'];
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = sign(encoded, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.uid || !payload.username || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function setSession(reply: FastifyReply, token: string, secure: boolean): void {
  reply.header(
    'Set-Cookie',
    `ledger_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 14}${secure ? '; Secure' : ''}`,
  );
}

export function clearSession(reply: FastifyReply, secure: boolean): void {
  reply.header(
    'Set-Cookie',
    `ledger_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`,
  );
}
