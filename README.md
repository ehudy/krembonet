# KremboNet

A small self-hosted dashboard for hardware on your local network. It polls devices that
a cloud service can't reach, and serves their telemetry over plain HTTP.

Today that means **printers** — supply levels, loaded media, and (over IPP) the live
print queue — with email alerts when a supply crosses a threshold. Two adapters ship:

| Adapter | Speaks                               | Reports                          | Good for                                           |
| ------- | ------------------------------------ | -------------------------------- | -------------------------------------------------- |
| `ipp`   | IPP via `ipptool`                    | supplies, media, **print queue** | Anything IPP, including large-format plotters      |
| `snmp`  | SNMP v1/v2c/v3, RFC 3805 Printer MIB | supplies, media                  | HP, Xerox, Brother, Lexmark, Ricoh, Kyocera, Sharp |

Runs as a single container with a SQLite file next to it. No cloud account and no agent
on the device. The only outbound connection it makes on its own is a once-a-day check
with GitHub for a newer release — no telemetry, nothing about your install, and it can
be turned off. Everything else stays on your network.

> **Status: early.** The SNMP adapter is written to the standard and tested against
> fixtures encoding documented RFC 3805 behaviour, but it has been exercised against a
> limited range of real hardware. A walk captured from your printer is the most useful
> thing you can contribute — see [CONTRIBUTING.md](CONTRIBUTING.md).

## What it does

- **Polls supplies and media over SNMP or IPP.** Ink and toner levels, waste and
  maintenance tanks, and what paper is loaded in which tray — read on a schedule you set,
  from devices that were never going to phone a cloud service.
- **Shows the live print queue**, on anything reachable over IPP.
- **Finds printers for you.** Auto-discovery sweeps a subnet, identifies what answers on
  IPP or SNMP, and adds it in one click. Adding by hand has a **Test connection** button
  that reports what a device can actually tell you _before_ you save it.
- **Alerts on rules you write.** Offline, supply low, waste box full, paper out — scoped
  to all printers or a chosen few, at your threshold or the hub's, once or repeating.
  Delivered by email and to Discord, Slack, ntfy or a generic JSON endpoint.
- **Names the paper.** Printers report media as opaque vendor codes; map a code to a
  friendly name once, globally or per printer, and it reads that way everywhere.
- **Keeps a history.** Supply readings, alert deliveries and device events, in SQLite on
  a volume you control.
- **Stays on your network.** No account, no agent, no telemetry. Secrets are encrypted at
  rest with AES-256-GCM.

## Pages

| Route                    | What it is                                                                  |
| ------------------------ | --------------------------------------------------------------------------- |
| `/setup`                 | First-run wizard — shown only until an admin password exists                |
| `/`                      | Overview — status cards for every monitored device, plus hub health         |
| `/devices`               | Every device, searchable and filterable by status                           |
| `/devices/:slug`         | Device detail — supplies, media, live print queue                           |
| `/admin`                 | Settings: hub name, dashboard access, appearance, SMTP, thresholds, cadence |
| `/admin/devices`         | Add, edit and remove devices; test a connection before saving               |
| `/admin/paper-types`     | Media code → friendly name mapping                                          |
| `/admin/alerts`          | Alert history and what is currently alerting                                |
| `/admin/alerts/rules`    | Alert rules — what to watch, on which printers, and who to tell             |
| `/admin/alerts/webhooks` | Webhook destinations — Discord, Slack, ntfy, generic JSON                   |

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
_reports_, never how.

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

| Data                      | Cadence                               | Why                                                                                    |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| Ink, paper, printer state | Hourly background cron (configurable) | Moves over days. This pass also evaluates alerts, so it must run with no browser open. |
| Print queue               | On demand, 15s TTL                    | Only useful live. An open dashboard polls it every 60s.                                |

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

Two tables, and the distinction is the whole design.

`alert_rules` holds **thresholds** — the measurement. A row with no device is
the default for everything; a row naming a device overrides it, and a row naming
a supply overrides that. This is what turns a bar red and files a cartridge
under "needs re-order", and it applies whether or not anyone is being notified.
The API and the UI both read the evaluated result, so the number shown on a bar
and the number the engine acts on cannot drift apart.

`notification_rules` holds **delivery policy** — who gets told, covered under
[Alert rules](#alert-rules) below. Turning off an email must never stop the
dashboard telling the truth, which is why collapsing the two into one table
would be wrong however tempting the shared name is.

Alerts are **edge-triggered**: mail goes out when a supply crosses its threshold, not on
every poll where it happens to be past it. Otherwise a cartridge sitting at 10% would
mail you once an hour forever. Clearing requires recovering past the threshold by a
hysteresis margin, so a level flickering across the boundary cannot produce a stream of
breach/clear/breach mail.

The maintenance tank is evaluated in the opposite direction from ink — it alerts when
**full**, not when low. Applying one rule to both would leave it silent as it filled and
shouting when it was fresh. See `docs/canon-tz32000-field-notes.md` §4.

Everything that crosses in the same cycle is batched into one message.

#### Offline and recovery

A device that stops answering is alerted on separately from its supplies, since
"no reading" is exactly the condition being reported. It takes **two consecutive
failed polls** before a device is called offline — one missed poll is a printer
asleep, a lease renewing, or a switch rebooting, and alerting on it produces a
stream of offline/recovered pairs that teaches everyone to filter the sender.

Both directions are edge-triggered: one message when it goes down, one when it
comes back, and nothing in between however long the outage lasts.

#### Muting

One switch per device, under **Admin → Devices → Alert suppression**:
**maintenance mode**, for the machine with its lid off on a bench. While it is
on, no rule fires for that printer.

It used to be four — maintenance mode plus one per category. The three category
switches went when notification became rule-driven: "mute supply alerts for
this printer" is now something you express by scoping a rule, in the one place
the rest of the routing lives, rather than by a flag on the device that
silently overrode it from somewhere else.

Suppression silences _notification_, never monitoring. A muted device is still
polled, still evaluated, still shown as failing on the dashboard, and its alerts
are still written to the log with a `muted` status — only the email and the
webhooks stop. A mute that also stopped monitoring would mean a printer put into
maintenance in March is quietly unmonitored in September, and nobody would find
out until they walked past it. Muted devices carry a small bell-off marker on
their card and row.

One consequence worth knowing: alert _state_ is tracked while muted, so a supply
that crosses its threshold during a mute and is still across it when the mute
lifts does not then fire. The condition never transitioned — the dashboard has
been showing it the whole time — and re-announcing old news on unmute would be
the more surprising behaviour.

#### Destinations

Alerts go to email and to any configured **webhooks**, together. Four payload
formats ship: Discord, Slack (which Mattermost also accepts), ntfy.sh, and a
generic JSON POST. The format is a per-destination setting rather than something
sniffed from the URL, so a self-hosted receiver on an unrecognisable hostname can
still be told to speak Slack.

Destinations are independent. A revoked Discord webhook does not stop the mail,
does not stop the other webhooks, and does not stop the poll — every failure is
recorded against its own row and shown in the portal. An alert counts as
delivered if _any_ destination took it, so one dead receiver cannot re-arm the
alert and make it fire every hour.

Configure them under **Admin → Alerts → Webhooks**, where each has a Test button.
The test posts to the _saved_ row, not to the form, so a green result means the
destination that will actually fire at 2am works.

#### What the mail looks like

Alert email is branded HTML, carrying the hub's own name and logo, with a plain
alternative for clients that will not render it.

The body is **self-contained by design**. Printers and the hub often sit on an
isolated VLAN the person reading the alert cannot reach, so the message carries
every fact needed to act — device name, model, location, address, and each
condition in the batch — rather than a link and a promise. Severity follows the
same rule the portal uses: a low consumable is a warning, a stopped or offline
device is critical, and a batch containing both is critical. The button back to
the hub is a convenience, not the point, and is omitted entirely when
`PUBLIC_BASE_URL` is unset — a dead link is worse than no link.

The logo is **attached to the message** and referenced by Content-ID, not linked.
This is the one part worth knowing about, because the obvious approach does not
work: `<img src="{logoUrl}">` fails for all three shapes a self-hosted hub's logo
actually takes — a `data:` URI, a site-relative path, and a URL on a private
VLAN. Gmail's image proxy cannot fetch any of them, and each arrived as a broken
image. Attaching the bytes sidesteps the fetch entirely.

A remote `http(s)` logo is deliberately **not** fetched. Reaching out to an
operator-supplied URL at send time is network I/O with an SSRF surface on it, and
the mailer declines. It falls back to a text header carrying the hub name, which
is also what happens when there is no logo, or when the file is unreadable or is
not an image. The header degrades to text; it never renders a broken image.

#### Alert rules

Notification is **opt-in**. Nothing is emailed or posted to a webhook unless a
rule under **Admin → Alerts → Rules** asks for it — a hub with no rules is
silent, however loudly its printers complain.

That is a deliberate reversal of how this used to work. The old engine mailed on
every threshold crossing on every device the moment SMTP was configured, which
is right for three printers and unusable for thirty: the only way to stop being
paged about the spare in the store room was to mute it by hand.

> **Upgrading?** Existing installs go quiet until you add a rule. One rule —
> all printers, "supply level low", no threshold, send email — reproduces the
> old behaviour for supplies; add a second for "device offline" to match it
> fully.

A rule names four things:

|                  |                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope**        | All printers, or a chosen few.                                                                                                               |
| **Condition**    | Device offline, supply level low, waste box full, or paper out.                                                                              |
| **Threshold**    | Minutes for offline, percent for a supply. Blank means "whenever the hub already calls it a problem" — the same mark that turns the bar red. |
| **Destinations** | Email (optionally to addresses of the rule's own) and any of the configured webhooks.                                                        |

Rules own their own edges, and so does each condition within a rule: two rules
watching the same cartridge at different percentages each announce themselves
once, and a rule's offline alert does not swallow its own low-ink one. Where
two rules cover the same printer, their destinations are unioned rather than
resolved to the more specific — both audiences asked to be told.

Two things are called a rule in this codebase and they are not the same. This
table is _delivery policy_. The thresholds on the Settings page are
_measurement_: they decide when a bar turns red and what the Supplies page files
under "needs re-order", and they apply whether or not anyone is being notified.
Turning off an email must never stop the dashboard telling the truth.

#### What still happens without rules

Everything except the message. Conditions are detected, the activity log records
them, bars go red, and the Overview counts them. A hub configured with no rules
at all is a working dashboard that never interrupts anyone — which is a
reasonable way to run one.

#### Reading what is alerting

**Admin → Alerts → History** lists every outstanding condition as a card: the
printer, what kind of alert it is, how long it has been going, and how many
times it has been notified. Each card carries a **Put in maintenance mode**
button, since that is what an operator does next about nine times in ten and it
otherwise meant navigating to the device form to find a checkbox.

## Requirements

- Node 22+
- `ipptool` (ships with CUPS; present by default on macOS, `cups-ipp-utils` on Debian)
- Docker + Docker Compose (for the container deployment)

`ipptool` is a real dependency, not a convenience — the IPP layer shells out to it. The
Docker image installs it for you, which is why Docker is the recommended way to run this.

## Quick start

```bash
docker compose up -d --build
```

That is the whole thing. **No `.env` file is required** — every setting has a working
default, and the two secrets that need to be stable across restarts (the encryption key
for stored credentials, and the cookie signing secret) are generated on first boot and
kept in `data/`.

Open `http://localhost:8080`. A fresh install shows a short setup screen: pick an admin
password and a name for the hub, and you are in. Then add devices from **Admin →
Devices** — enter an address, press **Test connection**, and it will tell you what
answered and what it can actually report before you save anything.

`.env` is entirely optional, and worth creating when you want to pin something rather
than let it be generated:

```bash
cp .env.example .env   # only if you want to change something
```

The ones most likely to matter: `ENCRYPTION_KEY` to keep the key out of `data/` (see
[Secrets at rest](#secrets-at-rest)), `TZ` so the poller's schedule matches your clock,
`COOKIE_SECURE=true` behind HTTPS, and `ADMIN_PASSWORD` for deployments provisioned by a
script that cannot run a wizard. `PLOTTER_HOST` / `PLOTTER_IPP_URI` still seed a device
from the environment. Every variable is listed under
[Environment variables](#environment-variables).

Rather than typing addresses in, **Admin → Devices → Auto-discover** sweeps a subnet
(`192.168.0.0/24` by default) for anything answering on IPP or SNMP, identifies each one with the
same probe the manual button uses, and adds it in one click.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Vite serves the UI on `http://localhost:5173` and proxies `/api` to Fastify on `:3000`.
In production Fastify serves the built SPA itself, so there is no CORS surface.

| Command                                                    | Purpose                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `npm run dev`                                              | Both servers with hot reload                             |
| `npm run build`                                            | Build SPA into `server/public/`, then compile the server |
| `npm test`                                                 | Unit tests (run offline against captured fixtures)       |
| `npm run typecheck`                                        | Typecheck both workspaces                                |
| `npm run lint`                                             | ESLint                                                   |
| `npm run probe --workspace=@krembonet/server -- <ipp-uri>` | Query a live printer through the real IPP stack          |

## API

| Route                              | Returns                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `GET /api/health`                  | Liveness and version, used by the Docker healthcheck             |
| `GET /api/hub`                     | Hub name, theme, and custom CSS — the chrome the SPA needs first |
| `GET /api/access`                  | Whether this browser may read the dashboard, and why not         |
| `POST /api/access/unlock`          | Exchanges the viewer passcode for a viewer cookie                |
| `GET /api/devices`                 | Registered devices, their online state and capabilities          |
| `GET /api/printers/:slug/status`   | Full cached snapshot — supplies, media, jobs                     |
| `POST /api/admin/devices/probe`    | Identifies one address (admin only)                              |
| `POST /api/admin/devices/discover` | Sweeps a subnet and identifies what answers (admin only)         |

The device endpoints are subject to the access mode below; `/api/health`,
`/api/hub`, and `/api/access` stay open, since the shell has to render its own
name and theme behind a passcode prompt.

A device seeded from the environment gets the slug `plotter`. `GET /api/printers`
and `/printers/:slug` are kept as aliases so older links keep resolving.

These endpoints read the poller's cache and never contact the device, so response time is
independent of device health and the device's load does not grow with the number of
viewers.

When a poll fails, `status` keeps serving the last good reading with `isOnline: false`
plus `lastError` and `lastSuccessAt`, so the dashboard can show stale data with a warning
rather than going blank.

## Admin portal

Login is a single shared password exchanged for a signed, expiring cookie. Failed
attempts are throttled per IP. There are no user accounts: one admin role and a handful
of people who use it, so accounts would be ceremony without benefit.

The password is stored as a **scrypt hash** in the database, never in plaintext and never
compared in plaintext. There are two ways to set it:

- **The setup wizard**, on first run. This is the normal path.
- **`ADMIN_PASSWORD` in `.env`**, for deployments provisioned by a script. It is hashed
  into the database at boot rather than checked on each login, and changing it re-seeds
  the hash on the next restart. A password set through the wizard takes precedence and is
  never overwritten by a lingering environment variable — the hub logs that it ignored it.

A blank `ADMIN_PASSWORD` on a hub with no stored password **disables** the portal rather
than leaving it open. Production refuses to boot without a stable `SESSION_SECRET`, since
a random one would log every admin out on each restart:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Dashboard access

Who may see device status is a setting, not a deployment concern:

| Mode         | Who gets in                                                                               |
| ------------ | ----------------------------------------------------------------------------------------- |
| `public`     | Anyone who can reach the hub. The default, and how every hub behaved before this existed. |
| `passcode`   | Viewers enter a shared passcode once per browser.                                         |
| `admin_only` | Only a signed-in admin.                                                                   |

The viewer passcode is **not** the admin password. It is stored as its own
scrypt hash, throttled on its own per-IP counter, and grants read access and
nothing else — a viewer who knows it cannot reach `/api/admin/*`, probe a
device, or change a setting.

Two deliberate refusals:

- Switching to `passcode` without setting a passcode is rejected at the form.
  If that state arises anyway, the server falls back to admin-only rather than
  to open — a half-configured gate must not publish the dashboard at the moment
  you meant to restrict it.
- `/admin` stays reachable in every mode. Gating it would make `admin_only`
  unrecoverable, since the only way back in is the sign-in page the gate would
  be covering.

### Language

The UI ships in **English and Spanish**. **Admin → Settings → Appearance** has a
language selector: _System default_ follows each visitor's browser, or pin one for
everyone who opens the hub. The resolved locale is cached in `localStorage`, so a reload
paints in the right language rather than flashing English first.

Adding a language is two files and no code: copy `web/src/i18n/locales/en.json`, translate
the values, and register it in `web/src/i18n/i18n.tsx`. A test asserts every locale has
exactly the same keys and the same `{{placeholders}}` as English, so a missed string fails
the suite rather than surfacing months later as one button in the wrong language.

Plurals go through `Intl.PluralRules`, not an `n === 1` check — that check is correct for
English by accident, and Spanish agrees with it, but Polish and Arabic do not.

Device names, locations and paper codes are your data and are never translated. Errors
generated by the server are currently English.

### Appearance

The palette is a near-black canvas with a single warm amber accent, carried on
CSS custom properties: `--bg`, `--surface`, `--border`, `--text`, `--accent` and
the status colours. Dark is the base and light is the override, so both themes
share one accent — an accent that shifts hue between themes is two brands.

`system`, `light`, `dark`, or `kiosk` — the last being dark with larger text and
no navigation chrome, for a display bolted to a wall. Custom CSS is appended
after the built-in stylesheet, so operator rules win without `!important`.
Override the custom properties on `:root` rather than restyling each component:

```css
:root {
  --accent: #2563eb; /* your colour, everywhere it appears */
}
```

**Hub name, subtitle and logo** are set in the same place. A blank subtitle
hides the line under the name entirely rather than falling back to a default —
blank is a layout choice, not a missing value. A logo replaces the name and
subtitle; it takes a URL, a path this hub serves, or an inline `data:` image,
which is usually easiest on a LAN with no web server to host from.

**The favicon** has its own field, because the image that works in a header
rarely works at 16 pixels — a wide wordmark that reads fine above the nav
becomes an unreadable smear in a tab. Set it and the tab icon is yours; leave it
blank and the hub falls back to the logo, then to its own `/favicon.ico`, so a
hub that only ever sets a logo still gets a matching tab without touching this
field. It accepts the same shapes the logo does, plus `.ico` — in both MIME
spellings browsers use for it — and the portal shows the result at roughly tab
size, since that is the only size at which the choice can actually be judged.

Saved CSS is sanitised, and the portal reports what it changed. A literal
`</style>` is escaped (it would end the element and turn the rest into markup —
an injection reachable by viewers who are explicitly not trusted with the
portal), and `@import` and remote `url()` are stripped, since this hub does not
fetch anything off the local network. `data:` URIs are kept, which is how an
inlined logo arrives.

### Finding devices

**Admin → Devices → Auto-discover** takes a subnet in CIDR form and sweeps it. IPP is
detected by a TCP connect to 631; SNMP by a real GET of `sysDescr` on 161, because from
the outside a closed UDP port and a silent one look the same. That means **a device using
a non-default SNMP community will not be found** — the community used for the sweep is a
field on the form, and anything still missing can be added by address.

Everything that answers is then run through the same probe the manual **Test connection**
button uses, so a discovered device is identified by identical code to one typed in by
hand. Results carry the probe's own caveats: "responded, but reported no supplies" is the
difference between a device worth adding and one that will never alert.

Discovery only ever proposes. Nothing is written until someone presses **Add**, and
devices already registered are marked rather than offered a second time.

Bounds, because this is a port scanner: `/20` maximum (4094 hosts), a short per-host
timeout, capped concurrency, at most 32 hosts identified per sweep, and a total deadline
after which partial results come back marked as partial. Public address ranges are
refused unless `DISCOVERY_ALLOW_PUBLIC_RANGES=true`.

### Adding devices

**Admin → Devices** takes an address and an adapter. The connection form is generated
from whatever the adapter declares it needs, so it shows an IPP URI for IPP and SNMP
version, community and v3 credentials for SNMP.

**Test connection** probes every adapter, ranks them by how confident each is, and shows
what it found: identity, which capabilities that device actually supports, a live sample
of its supplies, and the caveats. That last part is the useful bit — "responded" and
"reports anything you can alert on" are different claims, and this is where you find out
that a printer's trays only report low/OK.

Credentials you enter are stored per device and never sent back to the browser. Leaving a
password field blank when editing keeps the stored value.

### Security posture — read this before exposing it

This is built for a trusted LAN and the defaults say so:

- **The session cookie is not `Secure` by default**, because the intended deployment is
  plain HTTP on a local network, where a Secure cookie is never sent and nobody can log
  in. Set `COOKIE_SECURE=true` when serving over HTTPS.
- **The admin password is a single shared secret.** It is hashed with scrypt at rest and
  never compared in plaintext, but there are no user accounts, no roles and no audit of
  who did what.
- **Secrets are encrypted at rest, but the key is not.** See below. The key lives in the
  environment or in `data/`, so anyone who can read either can read the secrets; what this
  protects is the database _file_.
- **Secrets are never returned to the browser.** The settings API exposes a
  `smtpPasswordSet` flag, device config exposes `secretsSet`, and webhooks expose header
  _names_ only. Saving a form with a secret field blank keeps the stored value rather
  than clearing it.
- **Subnet discovery is a port scanner** and is admin-only for that reason. It refuses
  public address ranges by default and is bounded on every axis — subnet size, per-host
  timeout, concurrency, hosts probed, and total runtime.

Do not put this on the public internet as-is.

### Secrets at rest

Reversible secrets — the SMTP password, SNMP community strings, SNMPv3 auth and privacy
keys, and webhook auth headers — are encrypted with **AES-256-GCM** before they are
written to SQLite. GCM rather than CBC because it detects tampering: a row edited by hand
fails to decrypt instead of yielding plausible garbage that gets handed to an SMTP server.

The key is resolved in this order:

1. `ENCRYPTION_KEY`, if set — 64 hex characters.
2. `data/encryption.key`, if it exists.
3. Otherwise one is generated, written to `data/encryption.key` at mode `600`, and used.

Step 3 is what makes `docker compose up -d --build` work on a clean checkout. **Be clear
about what it costs:** the key then lives in the same directory as the database, so anyone
who copies all of `data/` has both. That still defends against the common accident — a
stray copy of `krembonet.db`, a support bundle, a backup of the database alone — but it is
not the same as keeping the key elsewhere. For anything you would mind leaking, set
`ENCRYPTION_KEY` in the environment and keep it out of `data/`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Either way, **back up whichever key you use**. It is never written to the database, so a
backup of `krembonet.db` alone cannot be decrypted. Losing the key means re-entering every
stored secret; the hub lists exactly which ones on the next boot rather than failing at 2am
on an alert that never sent.

A key that was _supplied_ is never silently replaced. A malformed `ENCRYPTION_KEY`, a
corrupt key file, or a key that does not match what the database was written with all stop
the boot with an explanation — because a hub that starts cleanly and cannot read its own
SMTP password is worse than one that refuses to start.

Password _hashes_ are deliberately left alone. The admin password and viewer passcode are
scrypt hashes that nothing reads back, so encrypting them would add no secrecy scrypt does
not already provide while turning a lost key into a hub nobody can sign in to.

Upgrading an existing install needs no manual step beyond setting the key. A sweep runs on
every boot and encrypts anything still in plaintext; it is idempotent, so the second boot
is a no-op, and interruptible, so a process killed halfway leaves a database that still
works and finishes on the next start.

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

### HTTPS and reverse proxies

The hub serves **plain HTTP** and binds to `0.0.0.0`. That is deliberate: the intended
deployment is a trusted LAN, and a self-signed certificate on a printer dashboard buys a
browser warning rather than safety. There is no certificate handling in the application
and none is planned — terminating TLS is a job the tools below already do well.

Whichever you use, **set `COOKIE_SECURE=true`** once the hub is reached over HTTPS. It is
off by default because a `Secure` cookie is never sent over plain HTTP, and a hub that
marks it unconditionally is a hub nobody can sign in to on a LAN.

**Tailscale** is the best answer for most people here, because it needs no certificate,
no port forwarding and no DNS. `tailscale serve` gives the hub an HTTPS name reachable
from your devices and nothing else:

```bash
tailscale serve --bg 8080          # https://<machine>.<tailnet>.ts.net → localhost:8080
```

**Caddy**, if you already run it, gets a certificate on its own:

```caddy
hub.example.com {
    reverse_proxy localhost:8080
}
```

**Nginx Proxy Manager**: add a Proxy Host pointing at the hub's address and port `8080`,
tick **Websockets Support** (harmless — the SPA polls rather than using a socket, but the
default off has surprised people), then request a certificate on the SSL tab. Plain nginx
is the same three lines everyone already has:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Two things to know before you do this:

- **The login rate limiter counts by source IP, and behind a proxy every request has the
  proxy's IP.** The lockout — 8 failed attempts, then five minutes — therefore becomes
  hub-wide rather than per-client. It still throttles a brute-force attempt; it also means
  one person fumbling the password locks the door for everyone until it expires. The
  server does not trust `X-Forwarded-For`, because a header a client can set is not an
  identity, and honouring it without pinning the proxy's address would hand an attacker
  an unlimited supply of fresh "IPs".
- **HTTPS does not make this internet-facing software.** See
  [Security posture](#security-posture--read-this-before-exposing-it): one shared admin
  password, no accounts, no audit trail. A VPN or a tailnet is the right boundary; a
  certificate is not.

### Environment variables

Every one is optional — `docker compose up -d --build` works with no `.env` at all. Set
one to pin a value rather than accept a default or a generated one. `.env.example` ships
the same list with the reasoning behind each.

| Variable                        | Default                 | What it does                                                                                                        |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                          | `3000`                  | Port inside the container. Compose publishes it on the host as `8080`.                                              |
| `HOST`                          | `0.0.0.0`               | Interface to bind. `127.0.0.1` only when a proxy on the same host is the sole reader.                               |
| `NODE_ENV`                      | `development`           | `production` in the image. Governs log level defaults and static file serving.                                      |
| `TZ`                            | `UTC`                   | Timezone for the poller's cron. Set it, or overnight alerts fire on someone else's clock.                           |
| `DATABASE_PATH`                 | `./data/krembonet.db`   | SQLite file. `/app/data/krembonet.db` in the container, on the `./data` volume.                                     |
| `ENCRYPTION_KEY`                | generated               | 64 hex chars encrypting secrets at rest. Generated into `data/` if unset — see [Secrets at rest](#secrets-at-rest). |
| `SESSION_SECRET`                | generated               | Signs the session cookie. Generated and stored in the database if unset. Changing it signs everyone out.            |
| `ADMIN_PASSWORD`                | _(wizard)_              | Hashed into the database at boot, for provisioned deployments. Blank shows the setup wizard instead.                |
| `SESSION_HOURS`                 | `12`                    | Admin session lifetime.                                                                                             |
| `VIEWER_SESSION_HOURS`          | `720`                   | Viewer (passcode) session lifetime. Long by design — a wall display should not ask daily.                           |
| `COOKIE_SECURE`                 | `false`                 | Marks the session cookie `Secure`. **Set `true` behind HTTPS.**                                                     |
| `BACKGROUND_POLL_MINUTES`       | `60`                    | First-boot poll cadence. After that the admin portal owns it.                                                       |
| `DEVICE_TIMEOUT_MS`             | `5000`                  | Ceiling on one device request, any protocol. `IPPTOOL_TIMEOUT_MS` is still honoured.                                |
| `DISCOVERY_ALLOW_PUBLIC_RANGES` | `false`                 | Lets a subnet sweep leave the private ranges. For networks that genuinely use public addressing internally.         |
| `DISCOVERY_DEADLINE_MS`         | `120000`                | Ceiling on one sweep. Partial results are returned and flagged as partial.                                          |
| `PUBLIC_BASE_URL`               | _(none)_                | How the hub is reached from a browser, e.g. `http://hub.lan:8080`. Only used to put a working link in a webhook.    |
| `MEDIA_PACK_PATH`               | _(none)_                | JSON file mapping vendor media codes to names — see [Paper name lookup](#paper-name-lookup).                        |
| `PLOTTER_HOST`                  | _(none)_                | Seeds one device on boot. Set with `PLOTTER_IPP_URI`, or neither.                                                   |
| `PLOTTER_IPP_URI`               | _(none)_                | IPP URI for the seeded device.                                                                                      |
| `PLOTTER_NAME`                  | `Plotter`               | Display name for the seeded device.                                                                                 |
| `LOG_LEVEL`                     | `info` / `debug` in dev | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. JSON on stdout.                                                 |

### Updates

The running version is shown in the sidebar footer and under **Admin → Settings →
About**. Once a day the hub asks GitHub whether a newer release exists; if there is one,
an unobtrusive badge appears next to the version, and clicking it shows the release notes
and the command to apply it:

```bash
docker compose up -d --build
```

The check is deliberately unremarkable when it fails. Offline, air-gapped, behind a proxy
that blocks github.com, or rate-limited — all produce the same result as being up to
date: no badge, no banner, no error, and nothing on the console. It has a 2-second
timeout, runs in the background so it can never delay a page load, and the result is
cached for 24 hours in the database, so restarting the container ten times in an
afternoon still makes at most one request.

It sends nothing about your install — no identifier, no device list, no telemetry. Turn
it off entirely with the **Check for updates** switch on the same page; the version still
shows, the hub just stops asking.

### What to back up

Back up the whole `data/` directory, not just `krembonet.db`. Unless you set
`ENCRYPTION_KEY` yourself, `data/encryption.key` is the only copy of the key that decrypts
stored credentials, and a backup of the database without it cannot be read. The session
signing secret lives inside the database and is restored with it.

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

- **Now** — first-run setup, device management in the browser with an on-demand probe,
  and two adapters: IPP (supplies, media, queue) and generic SNMP over RFC 3805 (supplies,
  media). Device-generic data model, capability-driven UI, hashed admin credentials.
  Alerts to email and to Discord/Slack/ntfy/generic webhooks. Dashboard access modes
  (public, shared passcode, admins only), themes including a kiosk mode, and custom CSS.
  Secrets encrypted at rest with AES-256-GCM, and subnet auto-discovery. Nothing needs to
  be configured by hand to get running.
- **Next** — non-printer adapters (ping, HTTP, UPS), and per-device alert rules in the UI
  (the schema already supports them).
- **Later** — dropping the `ipptool` binary dependency in favour of a pure-JS IPP client
  so `npm install && npm start` works anywhere. The adapter boundary makes that a swap
  rather than a rewrite.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). A parser for another
vendor's PPD, or a captured SNMP walk from a non-Canon printer, are both genuinely useful.

## License

MIT — see [LICENSE](LICENSE).
