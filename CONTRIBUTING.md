# Contributing

Thanks for taking a look. This is a small project with a narrow focus: reading telemetry
from hardware on a local network and showing it without a cloud round-trip.

## Getting set up

```bash
cp .env.example .env
npm install
npm test
```

Tests run offline against captured fixtures, so you do not need a printer to work on most
of the codebase. You do need Node 22+; `ipptool` is only required if you want to talk to a
real device.

Before opening a pull request:

```bash
npm test && npm run typecheck && npm run lint
```

## The most useful contributions

**Captured device output.** The single biggest limitation is that this was developed
against one printer. A `.plist` from `ipptool -X` or a JSON dump of an `snmpwalk` against
a printer from any other vendor is genuinely valuable — it turns "we think this works"
into a test. Scrub hostnames, IPs, usernames, and job names before sending; see below.

**A PPD parser for another vendor.** `server/scripts/generate-media-seed.ts` currently
understands Canon's `*CNIJMediaType` pairs. Other vendors encode media differently.

**Bug reports with the raw attribute dump attached.** `npm run probe -- <ipp-uri>` prints
exactly what the parser saw.

## Please do not commit

- IP addresses, hostnames, MAC addresses, or subnets
- Usernames, email addresses, or real print-job names
- Company names, office names, or site codes
- Anything from `.env`, `data/`, or a real `media-pack.json`

Fixtures use `printer.example` and placeholder usernames; please match that. The
`.gitignore` covers `.env`, `data/`, and `*.db`, but it cannot catch a hostname pasted
into a doc.

## Code conventions

- TypeScript throughout. The server uses `NodeNext` module resolution, so **relative
  imports carry a `.js` suffix** even in `.ts` files. The web workspace does not.
- Prettier and ESLint are configured; `npm run format` before committing.
- Comments explain *why*, not *what*. The existing code leans on this heavily — several
  files exist in their current shape because of a specific device misbehaviour, and the
  comment is the only record of that. Please keep the habit.
- `docs/canon-tz32000-field-notes.md` is cited by section number from
  `schema.ts`, `devices/types.ts`, `normalize.ts`, and `settings/types.ts`. If you change
  a finding, update the citations.

## Architecture notes worth knowing

- **Only the poller touches a device.** Routes read a cache. If you find yourself making
  a device call from a request handler, that is a sign something belongs in the poller.
- **`server/src/devices/types.ts` is deliberately free of IPP vocabulary.** It is the
  boundary a future SNMP adapter plugs into. Keep protocol-specific names out of it.
- **Alerting logic in `alerts/rules.ts` is pure** — no database, no SMTP — so it can be
  tested directly. Keep I/O in `alerts/engine.ts`.

## Adding a device adapter

The adapter interface does not exist yet; see the roadmap in the README. If you want to
work on it, please open an issue first so we can agree on the shape before you write code
— particularly around how supply levels are represented, since the standard SNMP Printer
MIB reports raw values against a capacity plus "unknown" and "some remaining" sentinels
rather than percentages.
