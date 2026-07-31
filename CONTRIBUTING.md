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

**A captured SNMP walk from your printer.** This is the single most useful thing you can
send. The SNMP adapter is written to RFC 3805 and tested against fixtures that encode
documented behaviour, but "implements the standard" and "implements the standard the way
your Sharp does" are different claims. A walk turns a guess into a test:

```bash
snmpwalk -v2c -c public -On printer.example 1.3.6.1.2.1.43 > printer.txt
snmpwalk -v2c -c public -On printer.example 1.3.6.1.2.1.25.3.5 >> printer.txt
snmpwalk -v2c -c public -On printer.example 1.3.6.1.2.1.1 >> printer.txt
```

Fixtures live in `server/test/fixtures/snmp/` as JSON maps of OID to value, with
`{"$hex": "..."}` for the binary bit-field columns. Scrub the hostname and serial number
before sending — see below. Say which printer it came from and what the front panel
showed at the time, since that is the ground truth the fixture is asserted against.

**Captured IPP output.** A `.plist` from `ipptool -X` against a non-Canon printer is
equally welcome.

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
- **`server/src/devices/types.ts` is deliberately free of protocol vocabulary.** It is
  the boundary every adapter plugs into. Keep protocol-specific names out of it.
- **Alerting logic in `alerts/rules.ts` is pure** — no database, no SMTP — so it can be
  tested directly. Keep I/O in `alerts/engine.ts`.

## Adding a device adapter

Implement `DeviceAdapter` from `server/src/devices/adapter.ts` and register it in
`server/src/devices/adapters/index.ts`. Look at `snmp-printer.ts` for the shape.

Four things are easy to get wrong:

- **Declare capabilities honestly.** Claiming `jobs` for a protocol that cannot report a
  queue leaves an empty panel on screen forever. Narrow further in `probe()` when a
  particular device turns out not to support something the adapter generally can.
- **Never invent a level.** If a device declines to report a number, return
  `{ kind: 'unknown' }`. Alerting skips it. A fabricated 0% gets acted on — someone
  reorders ink against it.
- **Keep the transport separate from the normaliser.** The parsing has to be testable
  against a captured fixture with no network, or nobody without that exact printer can
  work on it.
- **Mark credential fields `secret: true`** in the config schema so they are redacted in
  API responses.

For anything larger, open an issue first so we can agree on the shape.
