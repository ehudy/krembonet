/**
 * Admin authentication.
 *
 * A single shared password, exchanged for a signed session cookie. There is one
 * admin role and a handful of IT staff, so user accounts would be ceremony
 * without benefit — but the cookie is signed and expiring, not a bare
 * "loggedIn=true" flag a browser console could set.
 *
 * The password itself is a scrypt hash in the settings table; see
 * `credentials.ts` for how it gets there. Nothing here ever sees a stored
 * plaintext password.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../config.js';
import { getSettings } from '../settings/settings.js';
import { decideAccess, type AccessDecision, type Viewer } from './access.js';
import { checkAdminPassword, hasAdminCredential } from './credentials.js';
import { hasViewerPasscode } from './viewer.js';

export const SESSION_COOKIE = 'krembonet_admin';
export const VIEWER_COOKIE = 'krembonet_viewer';

/** True when an admin credential exists at all. */
export function isAdminEnabled(): boolean {
  return hasAdminCredential();
}

/**
 * Verifies a login attempt.
 *
 * Async because scrypt is deliberately slow — that cost is the point, and it
 * also flattens the timing difference between a wrong password and a missing
 * one down to whether a credential exists at all.
 */
export async function verifyPassword(candidate: string): Promise<boolean> {
  return checkAdminPassword(candidate);
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
 * Which credential an attempt was against.
 *
 * Counted separately so that someone fumbling the lobby passcode cannot lock an
 * admin out of the portal, and so that hammering the passcode does not buy any
 * information about the admin password's lockout state.
 */
export type LoginScope = 'admin' | 'viewer';

/**
 * Per-IP, per-scope throttle. In-memory is adequate: the service is LAN-only,
 * single instance, and a restart clearing the counter is not a meaningful
 * bypass given the attacker would have to cause the restart.
 */
const failures = new Map<string, FailureRecord>();

const bucket = (ip: string, scope: LoginScope): string => `${scope}:${ip}`;

export function loginLockRemainingMs(ip: string, scope: LoginScope = 'admin'): number {
  const record = failures.get(bucket(ip, scope));
  if (record === undefined) return 0;
  return Math.max(0, record.lockedUntil - Date.now());
}

export function recordLoginFailure(ip: string, scope: LoginScope = 'admin'): void {
  const now = Date.now();
  const key = bucket(ip, scope);
  const record = failures.get(key);

  if (record === undefined || now - record.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }

  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.count = 0;
    record.firstAt = now;
  }
}

export function clearLoginFailures(ip: string, scope: LoginScope = 'admin'): void {
  failures.delete(bucket(ip, scope));
}

interface SessionPayload {
  id: string;
  expiresAt: number;
}

function issue(reply: FastifyReply, cookie: string, hours: number): void {
  const payload: SessionPayload = {
    id: randomUUID(),
    expiresAt: Date.now() + hours * 60 * 60 * 1000,
  };

  reply.setCookie(cookie, JSON.stringify(payload), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Sent only over HTTPS when the hub is actually served over HTTPS. A
    // hardcoded `secure: true` on a plain-HTTP LAN deployment would mean the
    // cookie is never sent at all, locking admins out of their own hub.
    secure: config.cookieSecure,
    signed: true,
    maxAge: hours * 60 * 60,
  });
}

function hasValidCookie(request: FastifyRequest, cookie: string): boolean {
  const raw = request.cookies[cookie];
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

export function issueSession(reply: FastifyReply): void {
  issue(reply, SESSION_COOKIE, config.admin.sessionHours);
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function isAuthenticated(request: FastifyRequest): boolean {
  return hasValidCookie(request, SESSION_COOKIE);
}

/**
 * Viewer sessions last far longer than admin ones.
 *
 * The thing being protected is a read-only supply level, and the realistic
 * alternative to a long-lived cookie is an operator taping the PIN to the
 * monitor because the wall display keeps asking for it.
 */
export function issueViewerSession(reply: FastifyReply): void {
  issue(reply, VIEWER_COOKIE, config.viewer.sessionHours);
}

export function clearViewerSession(reply: FastifyReply): void {
  reply.clearCookie(VIEWER_COOKIE, { path: '/' });
}

export function isViewerAuthenticated(request: FastifyRequest): boolean {
  return hasValidCookie(request, VIEWER_COOKIE);
}

/** Fastify preHandler guarding every admin API route. */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isAdminEnabled()) {
    return reply.code(503).send({
      error:
        'Admin portal is disabled because no admin password has been set. Complete first-run setup, or set ADMIN_PASSWORD.',
    });
  }
  if (!isAuthenticated(request)) {
    return reply.code(401).send({ error: 'Not authenticated' });
  }
}

/** The three facts `decideAccess` needs, read off a live request. */
export function viewerOf(request: FastifyRequest): Viewer {
  return {
    isAdmin: isAuthenticated(request),
    isViewer: isViewerAuthenticated(request),
    passcodeSet: hasViewerPasscode(),
  };
}

export function accessFor(request: FastifyRequest): AccessDecision {
  return decideAccess(getSettings().accessMode, viewerOf(request));
}

/**
 * Fastify preHandler guarding the public status API.
 *
 * 403 rather than 401 throughout: the browser is not being asked to retry with
 * credentials it already has, it is being told which door to knock on, and the
 * SPA reads `reason` to decide between a passcode prompt and a sign-in link.
 */
export async function requireViewer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const decision = accessFor(request);
  if (decision.allowed) return;

  return reply.code(403).send({ error: decision.message, reason: decision.reason });
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const cookie = await import('@fastify/cookie');
  await app.register(cookie.default, { secret: config.admin.sessionSecret });
}
