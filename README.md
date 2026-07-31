# KremboNet

A small self-hosted dashboard for hardware on your local network. It polls devices that
a cloud service can't reach, and serves their telemetry over plain HTTP.

Today that means **large-format printers over IPP** — ink and maintenance-tank levels,
loaded paper rolls, and the live print queue — with email alerts when a supply crosses a
threshold. It was built against a Canon TZ-32000 plotter and is honest about that: the
normalization layer is shaped by one device's quirks. Support for other vendors over
SNMP is the next milestone, not a current feature.

Runs as a single container with a SQLite file next to it. No cloud account, no agent on
the device, nothing leaves your network.

> **Status: early.** The device layer is IPP-only and assumes one printer. If you have a
> non-Canon printer, it probably will not work yet — see [Roadmap](#roadmap).

## Pages

| Route | What it is |
| --- | --- |
| `/` | Overview — status cards for every monitored device, plus hub health |
| `/printers/:slug` | Device detail — supplies, media, live print queue |
| `/admin` | Settings: hub name, SMTP, alert thresholds, poll cadence |
| `/admin/paper-types` | Media code → friendly name mapping |
| `/admin/alerts` | Alert history and what is currently alerting |

## Architecture

One background poller is the only component that ever touches the device. It writes to
an in-memory cache and to SQLite; the HTTP API only reads that cache.

```
node-cron ──> ipptool -X ──> plist parse ──> normalize
                                                │
                                  ┌─────────────┴─────────────┐
                             memory cache                  SQLite
                                  │                            │
                             Fastify API  <────────────────────┘
                                  │
                             React SPA (polls /api, never the printer)
```

This one mechanism satisfies three requirements at once: the device sees exactly one
query per interval no matter how many dashboards are open; alerts run 24/7 without a
browser being open; and the last snapshot survives a restart.

### Polling cadences

Supplies and the print queue change at completely different rates, so they are polled
separately:

| Data | Cadence | Why |
| --- | --- | --- |
| Ink, paper, printer state | Hourly background cron (configurable) | Moves over days. This pass also evaluates alerts, so it must run with no browser open. |
| Print queue | On demand, 15s TTL | Only useful live. An open dashboard polls it every 60s. |

Requests never hit the device directly. The status route refreshes whatever has aged
past its TTL and then serves cache, so a page load shows live data while a burst of
simultaneous loads collapses into one query — measured at 30 concurrent requests
producing exactly one.

### Alerting

Alerts are **edge-triggered**: mail goes out when a supply crosses its threshold, not on
every poll where it happens to be past it. Otherwise a cartridge sitting at 10% would
mail you once an hour forever. Clearing requires recovering past the threshold by a
hysteresis margin, so a level flickering across the boundary cannot produce a stream of
breach/clear/breach mail.

The maintenance tank is evaluated in the opposite direction from ink — it alerts when
**full**, not when low. Applying one rule to both would leave it silent as it filled and
shouting when it was fresh. See `docs/canon-tz32000-field-notes.md` §4.

Everything that crosses in the same cycle is batched into one message.

## Requirements

- Node 22+
- `ipptool` (ships with CUPS; present by default on macOS, `cups-ipp-utils` on Debian)
- Docker + Docker Compose (for the container deployment)

`ipptool` is a real dependency, not a convenience — the IPP layer shells out to it. The
Docker image installs it for you, which is why Docker is the recommended way to run this.

## Quick start

```bash
cp .env.example .env
docker compose up -d --build
```

The dashboard is then on `http://localhost:8080`. Point `PLOTTER_HOST` and
`PLOTTER_IPP_URI` in `.env` at your printer; leave them empty and the hub starts with an
empty device list rather than probing an address.

Set `ADMIN_PASSWORD` and `SESSION_SECRET` to enable the admin portal.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Vite serves the UI on `http://localhost:5173` and proxies `/api` to Fastify on `:3000`.
In production Fastify serves the built SPA itself, so there is no CORS surface.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Both servers with hot reload |
| `npm run build` | Build SPA into `server/public/`, then compile the server |
| `npm test` | Unit tests (run offline against captured fixtures) |
| `npm run typecheck` | Typecheck both workspaces |
| `npm run lint` | ESLint |
| `npm run probe --workspace=@krembonet/server -- <ipp-uri>` | Query a live printer through the real IPP stack |

## API

| Route | Returns |
| --- | --- |
| `GET /api/health` | Liveness, used by the Docker healthcheck |
| `GET /api/hub` | The operator-configured hub name |
| `GET /api/printers` | Registered devices and their online state |
| `GET /api/printers/:slug/status` | Full cached snapshot — supplies, rolls, jobs |

A device seeded from the environment gets the slug `plotter`.

These endpoints read the poller's cache and never contact the device, so response time is
independent of device health and the device's load does not grow with the number of
viewers.

When a poll fails, `status` keeps serving the last good reading with `isOnline: false`
plus `lastError` and `lastSuccessAt`, so the dashboard can show stale data with a warning
rather than going blank.

## Admin portal

Set `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`. A blank `ADMIN_PASSWORD` **disables**
the portal rather than leaving it open, and production refuses to boot without a stable
`SESSION_SECRET` — a random one would log every admin out on each restart.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Login is a single shared password exchanged for a signed, expiring cookie. Failed
attempts are throttled per IP.

### Security posture — read this before exposing it

This is built for a trusted LAN and the defaults say so:

- **The session cookie is not `Secure`**, because the intended deployment is plain HTTP
  on a local network. If you put this behind TLS or on any untrusted network, that needs
  to change.
- **The admin password is a single shared secret read from the environment** and compared
  in plaintext. There are no user accounts and no password hashing at rest.
- **SMTP credentials are stored in plaintext** in the SQLite file. Anyone with filesystem
  access to `data/` can read them. Use a dedicated sending account — for Google Workspace,
  an App Password rather than the account password. The value is never sent back to the
  browser: the settings API exposes only a `smtpPasswordSet` flag, and saving the form
  with the field blank keeps the stored password.

Do not put this on the public internet as-is.

## Database

SQLite via Drizzle, at `DATABASE_PATH` (`./data/krembonet.db` by default). Migrations run
automatically at boot.

```bash
# after editing server/src/db/schema.ts
npx drizzle-kit generate
```

Migrations live in `server/migrations/` — deliberately outside `src/`, since `tsc` does
not copy `.sql` files into `dist/`.

`supply_history` is written only when a level actually changes, so a frequent poll does
not accumulate half a million no-op rows per supply per year.

### Paper name lookup

Printers report loaded media as opaque vendor codes (`com.canon-012f`) and neither IPP
nor SNMP exposes a human label. Unknown codes render as the raw code plus roll width —
never a guess.

No code table ships with this project: the names are vendor product names, and a table
built from one office's driver is wrong for the next. Generate your own from your
printer's PPD and point `MEDIA_PACK_PATH` at it:

```bash
npm run seed:media --workspace=@krembonet/server -- /path/to/printer.ppd media-pack.json
```

Names are also editable by hand in the admin portal, which marks the row operator-owned
so a later re-seed leaves it alone.

## Talking to the printer by hand

Useful when the dashboard disagrees with the device. Note that **`ipptool -v` prints
nothing** on CUPS 2.3.4 — you need `-tv` for human-readable output, or `-X` for the
structured plist the server actually parses.

```bash
ipptool -tv ipp://printer.example:631/ipp/print server/test/fixtures/get-printer-attributes.test
```

See [docs/canon-tz32000-field-notes.md](docs/canon-tz32000-field-notes.md) for what one
specific device does and does not report — several of its IPP attributes are misleading,
and that document is the reason the parser is written the way it is. It is also a
reasonable preview of the kind of quirk a new device adapter should expect.

## Deployment

```bash
docker compose up -d --build
```

Runs on port 8080 by default. A few things worth knowing about the host:

- **Stop the machine sleeping.** Display sleep is harmless, but system sleep suspends the
  poller, so overnight alerts would never fire.
- **Give the host a static IP or DHCP reservation**, since people will bookmark it.
- **Set `TZ`** in `.env`. Left at UTC, the poller's cron runs in UTC.

Useful checks:

```bash
docker compose ps
docker compose logs -f hub
docker compose exec hub ipptool -tv "$PLOTTER_IPP_URI" server/test/fixtures/get-printer-attributes.test
```

### Data safety

SQLite lives on the `./data` bind mount, so `--build` never wipes settings or history.
`data/` is gitignored; back it up if the alert history matters.

To reset entirely, stop the stack and delete `data/` — it is rebuilt on the next boot.

### Notes on the image

- Base is **Debian trixie**, not bookworm: `better-sqlite3`'s Linux prebuilds need
  `GLIBC_2.38` and bookworm ships 2.36, which builds cleanly and then crash-loops on
  `dlopen`.
- `npm ci` runs with `--ignore-scripts`. `better-sqlite3` ships a `binding.gyp`, so npm
  would otherwise try `node-gyp rebuild` and demand a Python/C++ toolchain, even though
  the package already ships prebuilt binaries. No package in the lockfile declares an
  install script; re-check with `grep '"hasInstallScript": true' package-lock.json`
  before adding native dependencies.
- The container runs as the unprivileged `node` user.

### Optional uptime monitoring

An [Uptime Kuma](https://github.com/louislam/uptime-kuma) sidecar is available behind a
Compose profile, for reachability checks on devices this project does not yet speak to:

```bash
docker compose --profile monitoring up -d
```

## Roadmap

- **Now** — single printer over IPP: queue, ink, paper, email alerts, admin portal.
- **Next** — a device-adapter interface and a generic SNMP adapter (RFC 3805 Printer MIB)
  so HP, Xerox, Brother, Sharp, Kyocera and Lexmark work without vendor-specific code.
  The honest caveat: standard-MIB supply levels are not percentages and carry
  "unknown"/"low" sentinels, so this needs a level model richer than a single integer.
- **Later** — a first-run setup wizard, adding devices from the UI with an on-demand
  probe, hashed admin credentials, and non-printer adapters (ping, HTTP, UPS).

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). A parser for another
vendor's PPD, or a captured SNMP walk from a non-Canon printer, are both genuinely useful.

## License

MIT — see [LICENSE](LICENSE).
