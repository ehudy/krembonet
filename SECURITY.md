# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability**
button on the Security tab, rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept helps
enormously. There is no bounty — this is a small self-hosted project — but every report
gets a reply.

## Threat model

KremboNet is built for a **trusted LAN**. It is not hardened for the public internet, and
the defaults reflect that. Knowing where the line is drawn matters more than a list of
features, so:

**In scope** — things that would be treated as vulnerabilities:

- Reading device status, settings, or secrets without the credentials the configured
  access mode requires.
- Reaching any `/api/admin/*` endpoint without an admin session (other than login,
  logout, and the session check).
- Command injection, path traversal, or SSRF reachable from anything a non-admin can
  submit.
- A stored secret appearing in an API response, a log line, or the SPA bundle.
- Escaping the subnet-discovery bounds — scanning a range larger than `/20`, or a public
  range without the opt-in.

**Out of scope** — known and accepted:

- **An attacker who already has the host, the process environment, or the whole `data/`
  directory.** Encryption at rest protects the database file, not a compromised host.
- **No `Secure` cookie by default.** The intended deployment is plain HTTP on a LAN,
  where a `Secure` cookie is never sent and nobody can log in. Set `COOKIE_SECURE=true`
  when serving over HTTPS.
- **One shared admin password.** No user accounts, no roles, no per-user audit trail.
- **The viewer passcode is a shared secret** and grants read access to device status.
- **An admin can make the server connect to arbitrary addresses** — that is what device
  probing and subnet discovery _are_. Both are admin-only for exactly this reason.
- **The daily update check**, which contacts `api.github.com`. It sends no data about the
  install beyond a `krembonet/<version>` user-agent, fails silently, and can be switched
  off in the admin portal.
- Denial of service from a device on the LAN answering slowly or maliciously. Timeouts
  and single-flight bound the damage; they do not eliminate it.

## What protects what

| Concern                                                    | Mechanism                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Admin password                                             | scrypt hash, never compared in plaintext, per-IP throttle with lockout                  |
| Viewer passcode                                            | separate scrypt hash, separate throttle bucket, read access only                        |
| Session                                                    | signed, expiring, `httpOnly` cookie — not a `loggedIn=true` flag                        |
| SMTP password, SNMP community and v3 keys, webhook headers | AES-256-GCM at rest; never returned to the browser                                      |
| Dashboard                                                  | `public` / `passcode` / `admin_only`, enforced server-side on every status route        |
| Custom CSS                                                 | sanitised — `</style>` escaped, `@import` and remote `url()` stripped                   |
| `ipptool` invocation                                       | `execFile` with an argument array; no shell is ever spawned                             |
| Subnet discovery                                           | admin-only, `/20` cap, private ranges only by default, bounded concurrency and deadline |

## Notes for auditors

A few things that look like problems and are not, so you can skip them:

- **`ipptool` is invoked via `execFile`, never `exec`.** Arguments are passed as an array
  directly to `execve`, so shell metacharacters in a device URI are inert. The URI is
  additionally required to match `^ipps?://`, which prevents a value beginning with `-`
  from being read as an option.
- **`server/test/fixtures/` contains no real device data.** Serial numbers and hostnames
  in the SNMP fixtures are fabricated; addresses throughout the repo are RFC 5737
  documentation ranges or RFC 1918 private ranges.
- **`npm audit` reports moderate advisories under `drizzle-kit`.** That is a
  `devDependency` used only to generate migrations, and `npm prune --omit=dev` removes it
  before it reaches the image. `npm audit --omit=dev` reports zero.
- **`server/test/route-guards.test.ts` is the standing check** that every `/api/admin`
  route carries `requireAdmin`. Exemptions live in one list in that file with a stated
  reason, so adding an unguarded admin endpoint fails the suite rather than shipping
  quietly.
