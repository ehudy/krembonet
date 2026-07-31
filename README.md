# KremboNet

A small self-hosted dashboard for hardware on your local network. It polls devices that
a cloud service can't reach, and serves their telemetry over plain HTTP.

Today that means **printers** — supply levels, loaded media, and (over IPP) the live
print queue — with email alerts when a supply crosses a threshold. Two adapters ship:

| Adapter | Speaks | Reports | Good for |
| --- | --- | --- | --- |
| `ipp` | IPP via `ipptool` | supplies, media, **print queue** | Anything IPP, including large-format plotters |
| `snmp` | SNMP v1/v2c/v3, RFC 3805 Printer MIB | supplies, media | HP, Xerox, Brother, Lexmark, Ricoh, Kyocera, Sharp |

Runs as a single container with a SQLite file next to it. No cloud account, no agent on
the device, nothing leaves your network.

> **Status: early.** The SNMP adapter is written to the standard and tested against
> fixtures encoding documented RFC 3805 behaviour, but it has been exercised against a
> limited range of real hardware. A walk captured from your printer is the most useful
> thing you can contribute — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Pages

| Route | What it is |
| --- | --- |
| `/` | Overview — status cards for every monitored device, plus hub health |
| `/devices/:slug` | Device detail — supplies, media, live print queue |
| `/admin` | Settings: hub name, SMTP, alert thresholds, poll cadence |
| `/admin/paper-types` | Media code → friendly name mapping |
| `/admin/alerts` | Alert history and what is currently alerting |

## Architecture

One background poller is the only component that ever touches the device. It writes to
an in-memory cache and to SQLite; the HTTP API only reads that cache.

```
node-cron ──> adapter registry ──> ipp  ──> ipptool -X ──> normalize
                                   snmp ──> net-snmp   ──> normalize
                                                │
                                  ┌─────────────┴─────────────┐
                             memory cache                  SQLite
                                  │                            │
                             Fastify API  <────────────────────┘
                                  │
                             React SPA (polls /api, never the device)
```

### Adapters

An adapter owns one way of talking to hardware. Everything above it — the poller, the
API, the UI — is written against a protocol-free interface and knows only what a device
*reports*, never how.

Capabilities are **declared, not discovered**. An adapter states what it can report and a
probe narrows that to what a particular device actually does, so the UI can tell an empty
print queue from a device that has no queue at all. That distinction is why the SNMP
adapter declares no `jobs`: the SNMP Job Monitoring MIB (RFC 2707) is effectively never
implemented, and pretending otherwise would leave an empty panel on screen forever.

Two guards bound how much traffic a device ever sees. **Single-flight** collapses
identical concurrent reads, so twenty dashboard loads are one query. **Serialisation**
allows only one conversation with a device at a time, whatever the protocol — concurrent
SNMP and IPP against the same box is a known way to make a cheap printer network stack
stop answering until it is power-cycled.

### What SNMP can and cannot tell you

Supplies read well across vendors. `prtMarkerSuppliesClass` distinguishes a cartridge
that drains from a waste tank that fills, and `prtMarkerSuppliesType` classifies toner,
ink, drums, fusers and staples — so no part of the read path inspects a vendor string.

Paper is weaker, and the project says so rather than papering over it. Trays routinely
answer with the "some remaining" sentinel instead of a number, and `prtInputMediaName` is
frequently blank. Expect loaded/not-loaded plus a declared size. **Remaining roll length
has no vendor-neutral OID at all** and is never reported.

`sysObjectID` identifies the vendor, but only for a display label and for ranking
adapters during a probe. It never changes how anything is parsed — the moment it did,
this would stop being a generic adapter.

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

### Supply levels

Levels are not stored as a single percentage, because devices routinely decline
to give one. A reading is one of four things: a trustworthy percentage, a raw
value against a capacity (SNMP reports impressions, sheets or millilitres as
often as percent), a bare "ok"/"needs attention", or an explicit unknown.

This matters more than it sounds. RFC 3805 reserves negative sentinels for
"unknown" and "some remaining, no number", and IPP's `marker-levels` is only a
percentage when the matching `marker-high-levels` is 100. Flattening all of that
into an integer means inventing numbers, and an invented toner level gets acted
on — someone reorders against it. Anything that cannot be compared is skipped by
alerting rather than defaulted to zero.

### Alerting

Thresholds live in the `alert_rules` table, not in settings. A row with no
device is the default for everything; a row naming a device overrides it, and a
row naming a supply overrides that. The API and the UI both read the evaluated
result, so the number shown on a bar and the number that sends mail cannot
drift apart.

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
| `GET /api/devices` | Registered devices, their online state and capabilities |
| `GET /api/printers/:slug/status` | Full cached snapshot — supplies, media, jobs |

A device seeded from the environment gets the slug `plotter`. `GET /api/printers`
and `/printers/:slug` are kept as aliases so older links keep resolving.

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

- **Now** — an adapter system with two adapters: IPP (supplies, media, queue) and generic
  SNMP over RFC 3805 (supplies, media). Device-generic data model, capability-driven UI,
  email alerts, admin portal.
- **Next** — a first-run setup wizard, and adding devices from the UI: enter an address,
  run an on-demand probe, let it rank the adapters and show what it found before saving.
  The probe already returns confidence, per-device capabilities and human-readable caveats;
  what is missing is the screen. Admin credentials move to a hash in SQLite at the same time.
- **Later** — non-printer adapters (ping, HTTP, UPS), and dropping the `ipptool` binary
  dependency in favour of a pure-JS IPP client so `npm install && npm start` works
  anywhere. The adapter boundary makes that a swap rather than a rewrite.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). A parser for another
vendor's PPD, or a captured SNMP walk from a non-Canon printer, are both genuinely useful.

## License

MIT — see [LICENSE](LICENSE).
