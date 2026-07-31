/**
 * Admin authentication.
 *
 * A single shared password from the environment, exchanged for a signed
 * session cookie. There is one admin role and a handful of IT staff, so user
 * accounts would be ceremony without benefit — but the cookie is signed and
 * expiring, not a bare "loggedIn=true" flag a browser console could set.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../config.js';

export const SESSION_COOKIE = 'krembonet_admin';

/** True when an admin password is configured at all. */
export function isAdminEnabled(): boolean {
  return config.admin.password !== '';
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak the
 * password length, so both sides are hashed to a fixed width first.
 */
export function verifyPassword(candidate: string): boolean {
  if (!isAdminEnabled()) return false;

  const expected = Buffer.from(config.admin.password, 'utf8');
  const actual = Buffer.from(candidate, 'utf8');

  const width = Math.max(expected.length, actual.length);
  const a = Buffer.alloc(width);
  const b = Buffer.alloc(width);
  expected.copy(a);
  actual.copy(b);

  return timingSafeEqual(a, b) && expected.length === actual.length;
}

interface FailureRecord {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;

/**
 * Per-IP throttle. In-memory is adequate: the service is LAN-only, single
 * instance, and a restart clearing the counter is not a meaningful bypass
 * given the attacker would have to cause the restart.
 */
const failures = new Map<string, FailureRecord>();

export function loginLockRemainingMs(ip: string): number {
  const record = failures.get(ip);
  if (record === undefined) return 0;
  return Math.max(0, record.lockedUntil - Date.now());
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const record = failures.get(ip);

  if (record === undefined || now - record.firstAt > WINDOW_MS) {
    failures.set(ip, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }

  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.count = 0;
    record.firstAt = now;
  }
}

export function clearLoginFailures(ip: string): void {
  failures.delete(ip);
}

interface SessionPayload {
  id: string;
  expiresAt: number;
}

export function issueSession(reply: FastifyReply): void {
  const payload: SessionPayload = {
    id: randomUUID(),
    expiresAt: Date.now() + config.admin.sessionHours * 60 * 60 * 1000,
  };

  reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Not `secure`: this is served over plain HTTP on the office LAN, and a
    // secure cookie would simply never be sent, locking admins out.
    secure: false,
    signed: true,
    maxAge: config.admin.sessionHours * 60 * 60,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function isAuthenticated(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw === undefined) return false;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return false;

  try {
    const payload = JSON.parse(unsigned.value) as SessionPayload;
    return typeof payload.expiresAt === 'number' && payload.expiresAt > Date.now();
  } catch {
    return false;
  }
}

/** Fastify preHandler guarding every admin API route. */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isAdminEnabled()) {
    return reply.code(503).send({
      error: 'Admin portal is disabled because ADMIN_PASSWORD is not set.',
    });
  }
  if (!isAuthenticated(request)) {
    return reply.code(401).send({ error: 'Not authenticated' });
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const cookie = await import('@fastify/cookie');
  await app.register(cookie.default, { secret: config.admin.sessionSecret });
}
