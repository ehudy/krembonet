# System and architecture

A short tour of how Krembonet is put together, aimed at an administrator deciding
how to deploy it or debugging why it shows what it shows. It describes the system
as built; the contributor-facing detail lives in `CONTRIBUTING.md` and `README.md`.

---

## The one rule

**Only the poller talks to a device. The HTTP API only reads a cache.**

Everything else follows from that. A printer is polled by exactly one component,
which writes what it finds to an in-memory cache and to SQLite. Every dashboard
request reads that cache, so a hundred open dashboards put no more load on a
printer than one — and a request handler never blocks on a slow device.

```
                 ┌────────────┐   IPP 631 / SNMP 161   ┌──────────┐
                 │   Poller   │ ─────────────────────▶ │ Printers │
                 └─────┬──────┘                        └──────────┘
                       │ writes
              ┌────────▼─────────┐
              │  In-memory cache │◀── reads ── HTTP API ──▶ Browser (polls)
              │   + SQLite (WAL) │
              └──────────────────┘
```

---

## Adapters and capabilities

A device is reached through an **adapter**. Two ship today:

- **IPP** — supplies, media, device state, **and the print queue**. The only
  adapter that can report a queue.
- **SNMP** (v1 / v2c) — supplies, media, and device state. No queue: SNMP's Job
  Monitoring MIB is effectively never implemented in the field.

Each adapter declares **capabilities** — `reachability`, `supplies`, `media`,
`jobs` — and a probe narrows that to what a *specific* device actually answered.
The dashboard renders panels for the stored capability set, so a device that
cannot report a queue shows no queue panel rather than an empty one. Capabilities
are decided at probe time and trusted thereafter; re-probe a device after changing
its settings to update them.

Two guards protect fragile printer network stacks: identical concurrent reads are
collapsed into one (single-flight), and only one conversation happens with a given
device at a time, whatever the protocol.

---

## Polling cadences

| Data | Cadence | Why |
| --- | --- | --- |
| Supplies, media, device state | Background timer, hourly by default (configurable in Admin → Settings) | Moves over days. This pass also evaluates alerts, so it must run with no browser open. |
| Print queue | On demand, short TTL; an open device page polls ~every 60s | Only useful live. A closed dashboard refreshes no queues. |

The browser uses ordinary polling over request/response HTTP. **There are no
Server-Sent Events or WebSockets** — which is why no special reverse-proxy
buffering or connection-upgrade handling is needed (see `TROUBLESHOOTING.md`).

---

## Supply levels

A level is reported as one of four honest kinds, never guessed:

- **percent** — a real value against a real maximum.
- **absolute** — a raw value and its capacity, when no percentage is offered.
- **binary** — the device reports only ok/attention (common for waste boxes and
  cheaper engines).
- **unknown** — the device declined to say. Alerting **skips** these rather than
  defaulting to `0%`, so a supply that is merely unreported never pages anyone.

---

## Print-queue reconciliation

An IPP spooler drops a job from its active list the moment the upload finishes,
while the engine keeps printing. Krembonet reconciles the reported queue against
the device's own state: a job that disappears while the printer still reports
`processing` is retained and shown as *Finishing* until the device reports `idle`.
A 30-minute safety cap releases a job whose printer never returns to idle. The
stored job table keeps device truth; the "finishing" status is a presentation
layer over it.

---

## Storage and alerting

- **SQLite in WAL mode** (`data/krembonet.db`) holds the latest reading per device
  plus supply-level history. WAL lets the API read while the poller writes. Run one
  hub per database file on local storage — see `TROUBLESHOOTING.md`.
- **Alerting** is two tables by deliberate design: `alert_rules` holds the
  *thresholds* (the measurement), and `notification_rules` holds the *delivery
  policy* (who gets told). Global thresholds act as fallbacks that a per-device or
  per-rule value can override, so the number an operator sees and the number
  alerting uses cannot drift apart.

---

## Deployment shape

The web UI is built into the server's static root and served by the same Fastify
process that exposes the API, with a SPA fallback for client-side routes. A reverse
proxy in front is optional and needs no special configuration. Device secrets (SNMP
communities and the like) are encrypted at rest with `ENCRYPTION_KEY`; changing
that key without migrating makes stored secrets unreadable, which surfaces as
devices going unreachable with a config error rather than as data loss.
