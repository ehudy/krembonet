/**
 * Password hashing.
 *
 * `scrypt` from `node:crypto` rather than bcrypt or argon2: both of those are
 * native modules, and adding one would break `npm ci --ignore-scripts` in the
 * container build and demand a compiler in the image. scrypt is memory-hard,
 * in the standard library, and entirely adequate for a single shared LAN
 * credential.
 *
 * The stored format carries its own parameters, so raising the cost later does
 * not invalidate existing hashes — an old hash still verifies with the
 * parameters it was written with.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * OWASP's floor for scrypt at the time of writing. `maxmem` has to be raised
 * from the Node default, which is too small for N=16384 at r=8.
 */
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const maxmemFor = (N: number, r: number): number => 256 * N * r * 2;

/**
 * Bounds on parameters read back from storage.
 *
 * `maxmem` is derived from the stored N and r, so without a ceiling a corrupted
 * or hand-edited row could ask Node to allocate an arbitrary amount of memory
 * and hang the login request that read it. Rejecting out-of-range parameters up
 * front turns that from a denial of service into a failed login.
 */
const LIMITS = {
  minN: 1 << 10,
  maxN: 1 << 20,
  maxR: 32,
  maxP: 16,
} as const;

function areSaneParameters(N: number, r: number, p: number): boolean {
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < LIMITS.minN || N > LIMITS.maxN) return false;
  // scrypt requires N to be a power of two greater than one.
  if ((N & (N - 1)) !== 0) return false;
  if (r < 1 || r > LIMITS.maxR) return false;
  if (p < 1 || p > LIMITS.maxP) return false;
  return true;
}

/** Anything shorter is trivially guessable, and this is a shared credential. */
export const MIN_PASSWORD_LENGTH = 8;

export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

/** `scrypt$N$r$p$saltBase64$hashBase64`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: maxmemFor(PARAMS.N, PARAMS.r),
  });

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verifies a candidate against a stored hash.
 *
 * Returns false rather than throwing for a malformed or unknown-algorithm
 * hash: a corrupted settings row should lock the portal, not crash every login
 * request.
 */
export async function verifyPassword(candidate: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!areSaneParameters(N, r, p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(candidate, salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
  } catch {
    // Parameters outside what this Node build will accept, e.g. an absurd N
    // from a hand-edited row.
    return false;
  }

  // Lengths match by construction, so timingSafeEqual is safe to call directly.
  return timingSafeEqual(derived, expected);
}
