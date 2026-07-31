/**
 * Environment parsing and validation.
 *
 * Fails fast at boot rather than surfacing an undefined halfway through a poll
 * cycle at 2am.
 */
import { randomBytes } from 'node:crypto';

function str(name: string, fallback?: string): string {
  const raw = process.env[name];
  // A present-but-empty value counts as unset. `.env` files habitually carry
  // blank keys as placeholders — `.env.example` ships several — and a blank
  // there has to mean "use the default", not "crash on boot". Plain `??` does
  // not catch this, since an empty string is neither null nor undefined.
  const value = raw === undefined || raw === '' ? fallback : raw;

  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

/**
 * The optional device seeded from the environment on boot.
 *
 * There is deliberately no default address. An unconfigured hub starts with an
 * empty device list and says so, rather than probing an address that belongs to
 * whoever happened to develop it.
 */
function seedPlotter(): { host: string; ippUri: string; name: string } | null {
  const host = optional('PLOTTER_HOST');
  const ippUri = optional('PLOTTER_IPP_URI');

  if (host === null && ippUri === null) return null;
  if (host === null || ippUri === null) {
    throw new Error(
      'PLOTTER_HOST and PLOTTER_IPP_URI must be set together, or neither. ' +
        'Set both to seed a device on boot, or leave both empty to start with none.',
    );
  }

  return { host, ippUri, name: optional('PLOTTER_NAME') ?? 'Plotter' };
}

export const config = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProduction: (process.env.NODE_ENV ?? 'development') === 'production',
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),

  databasePath: str('DATABASE_PATH', './data/krembonet.db'),

  /** Null when no device is configured. See `seedPlotter`. */
  plotter: seedPlotter(),

  /**
   * Optional JSON file mapping vendor media codes to friendly names. Null
   * leaves the table empty; see db/media-pack.ts.
   */
  mediaPackPath: optional('MEDIA_PACK_PATH'),

  /**
   * How this hub is reached from a browser, e.g. `http://hub.lan:3000`.
   *
   * Only used to put a working link in a webhook notification. The server
   * cannot infer it: it binds to 0.0.0.0 and sits behind whatever hostname or
   * reverse proxy the operator chose. Left null, notifications simply carry no
   * link, which is better than one that 404s in a Discord channel.
   */
  publicBaseUrl: (optional('PUBLIC_BASE_URL') ?? '').replace(/\/+$/, '') || null,

  /**
   * Background poll cadence used only on the very first boot, before any
   * settings row exists. After that it is owned by the admin portal and stored
   * in SQLite, so changing it does not need a redeploy.
   */
  initialBackgroundPollMinutes: int('BACKGROUND_POLL_MINUTES', 60),

  /**
   * Hard ceiling on a single device request, whatever the protocol.
   *
   * `IPPTOOL_TIMEOUT_MS` is still honoured so an existing .env keeps working;
   * `DEVICE_TIMEOUT_MS` is the name to use now that SNMP shares the budget.
   */
  deviceTimeoutMs: int('DEVICE_TIMEOUT_MS', int('IPPTOOL_TIMEOUT_MS', 5000)),

  /**
   * Marks the session cookie `Secure`.
   *
   * Off by default because the intended deployment is plain HTTP on a local
   * network, where a Secure cookie is simply never sent and nobody can log in.
   * Turn it on whenever the hub is reached over HTTPS.
   */
  cookieSecure: (process.env['COOKIE_SECURE'] ?? '') === 'true',

  admin: {
    /**
     * Empty disables the admin portal entirely rather than leaving it open —
     * a blank password must never mean "no password required".
     *
     * Read through `optional` rather than `str`, because `str` treats an empty
     * value as a missing one and throws: with `str` a blank ADMIN_PASSWORD
     * crashed the boot instead of disabling the portal as documented.
     */
    password: optional('ADMIN_PASSWORD') ?? '',
    /**
     * Signs the session cookie. A random value at boot is fine for dev; it
     * just means restarting logs you out. Production must set it explicitly,
     * which is enforced below.
     */
    sessionSecret: str('SESSION_SECRET', randomBytes(32).toString('hex')),
    sessionHours: int('SESSION_HOURS', 12),
  },

  viewer: {
    /**
     * How long a dashboard unlocked with the viewer passcode stays unlocked.
     *
     * Thirty days by default, against twelve hours for an admin session. The
     * two protect very different things: an admin session can change settings
     * and reach a device, while a viewer session shows read-only supply levels
     * on a LAN. A wall display that demands a PIN every morning gets the PIN
     * taped next to it, which is strictly worse than a long cookie.
     */
    sessionHours: int('VIEWER_SESSION_HOURS', 24 * 30),
  },
} as const;

if (config.isProduction && config.admin.password !== '') {
  if ((process.env['SESSION_SECRET'] ?? '') === '') {
    throw new Error(
      'SESSION_SECRET must be set in production — without a stable secret every ' +
        'restart invalidates admin sessions. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  if (config.admin.password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }
}

export type Config = typeof config;
