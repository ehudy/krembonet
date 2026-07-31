# Canon TZ-32000 — IPP and SNMP field notes

Captured live from a Canon TZ-32000 large-format plotter, queried from CUPS
2.3.4. Addresses below are placeholders; substitute your own device.

This is the device the project was originally built against. Several of its IPP
attributes are misleading or contradictory, and the parser in
`server/src/devices/ipp/` is shaped by these findings — **read this before
"simplifying" it**. It is also a fair sample of the kind of vendor quirk any
new device adapter should expect to hit.

---

## 1. `ipptool -v` prints nothing — use `-tv` or `-X`

```console
$ ipptool -v ipp://printer.example:631/ipp/print query.test
$ echo $?
0
```

Exit code 0, no output. `-t` is what enables the test report; `-v` alone only
raises verbosity within it. Any parser fed `-v` output silently sees an empty
string and reports an empty queue forever.

The server uses `-X`, which emits an XML property list.

## 2. `-X` gives typed, structured output

```xml
<key>marker-levels</key>
<array>
  <integer>10</integer>
  ...
</array>
<key>media-col-ready</key>
<array>
  <dict>
    <key>media-size</key>
    <dict>
      <key>x-dimension</key><integer>60960</integer>
      <key>y-dimension</key>
      <dict><key>lower</key><integer>20320</integer><key>upper</key><integer>1800000</integer></dict>
    </dict>
    <key>media-source</key><string>main-roll</string>
    <key>media-type</key><string>com.canon-012f</string>
  </dict>
  ...
</array>
```

Integers arrive as integers, `1setOf` as arrays, `rangeOfInteger` as
`{lower, upper}`, and nested collections survive intact. Text-mode regex parsing
cannot represent any of that, and breaks outright on job names containing commas
or quotes.

## 3. Six markers, not five

```
marker-names  = MBK, BK, Y, M, C, MC
marker-levels = 10, 100, 80, 80, 80, 20
marker-colors = #000000, #000000, #FFDA00, #F200FF, #00CFFF, #008080
marker-types  = ink-cartridge ×5, waste-ink
```

`MC` is the maintenance/waste cartridge. Confirmed by SNMP:

```console
$ snmpwalk -v1 -c public printer.example 1.3.6.1.2.1.43.11.1.1.6
... = STRING: "CANON Matte Black Ink Tank"
... = STRING: "CANON Black Ink Tank"
... = STRING: "CANON Yellow Ink Tank"
... = STRING: "CANON Magenta Ink Tank"
... = STRING: "CANON Cyan Ink Tank"
... = STRING: "CANON Waste Ink Tank"
```

## 4. The waste tank's percentage means the opposite of the inks'

For `marker-types = waste-ink`, CUPS reports **percent filled**, not percent
remaining. SNMP corroborates via the Printer MIB, where
`prtMarkerSuppliesLevel` for a receptacle is *remaining space*:

| Source | Raw | Meaning |
| --- | --- | --- |
| IPP `marker-levels[5]` | `20` | 20% **full** |
| SNMP level/max | `8000 / 10000` | 8000 units of space left → 20% full |
| SNMP `prtMarkerSuppliesClass` | `4` | `receptacleThatIsFilled` |

Both agree the tank is **20% full**. So a low-ink rule of "alert below 15%"
applied to `MC` would stay silent as the tank filled toward 100% and fire only
once it was nearly empty — precisely backwards.

`normalizeSupplies()` therefore tags this supply `kind: 'waste'`, and alerting
must treat it as counting *up*.

## 5. `printer-supply` is wrong on this device — do not use it

```
printer-supply = type=inkCartridge;maxcapacity=100;level=10;colorantname=lightGray;
                 type=inkCartridge;maxcapacity=100;level=100;colorantname=black;
                 type=inkCartridge;maxcapacity=100;level=80;colorantname=unknown;
                 ... 12 entries total, 6 of them at level=0
printer-supply-description = Canon Light Gray Ink Tank, Canon Black Ink Tank,
                             unknown, Canon Magenta Ink Tank, ...
```

Twelve slots for a five-ink plotter. The colorant names (`lightGray`,
`photoCyan`, `chromaOptimizer`) describe a different model in the TZ family, and
the six uninstalled slots report `level=0` — indistinguishable from "empty".

Reading this attribute would render six phantom empty cartridges and trigger six
false low-ink alerts.

**Use `marker-names` / `marker-levels` / `marker-colors` / `marker-types`.** Those
four agree with each other and with SNMP.

## 6. Colours come from the printer, but the two blacks collide

`marker-colors` supplies real hex values, so no hardcoded colour table is needed.
The one exception: MBK and BK both report `#000000`. `normalize.ts` overrides
matte black to `#4b5563` so the bars are visually distinct.

## 7. Friendly paper names are not available over IPP or SNMP

`media-col-ready` gives vendor codes only:

```
main-roll       media-type = com.canon-012f   x-dimension = 60960 (609.6mm / 24in)
alternate-roll  media-type = com.canon-0139   x-dimension = 60960
```

`media-type-supported` lists ~50 more `com.canon-XXXX` codes with no human
labels. SNMP is no better — the relevant OIDs are empty strings:

```console
$ snmpwalk -v1 -c public printer.example 1.3.6.1.2.1.43.8.2.1.12   # prtInputMediaName
... = ""
$ snmpwalk -v1 -c public printer.example 1.3.6.1.2.1.43.8.2.1.18   # prtInputDescription
... = ""
```

The printer's own web UI is a JavaScript SPA, so it cannot be scraped without a
headless browser.

Hence the `media_types` lookup table: populated from an optional media pack
generated from your printer's PPD, editable in the admin portal, and falling
back to `com.canon-0139 · 24in roll` for anything unrecognized. Never invent a
name for an unknown code.

> The original Python prototype's `"PremPlainPpr 80 (24 in Roll)"` strings were
> hardcoded placeholders, not live data.

## 8. Job-state enum: 7/8/9 are canceled/aborted/completed

Per RFC 8011 §5.3.7:

| Value | State |
| --- | --- |
| 3 | pending |
| 4 | pending-held |
| 5 | processing |
| 6 | processing-stopped |
| 7 | **canceled** |
| 8 | **aborted** |
| 9 | **completed** |

The Python prototype mapped 7/8/9 to completed/canceled/aborted, so every
canceled job displayed as "Completed". Regression-tested in
`test/normalize.test.ts`.

## 9. RESOLVED — the queue does report jobs

**Verified 2026-07-30.** `Get-Jobs` returns full job objects while a job is
open. The empty responses below were simply an idle printer.

Tested without printing anything, by exploiting the fact that `Create-Job`
enqueues a job with no document data:

```console
$ ipptool -tv ipp://printer.example:631/ipp/print queue-probe.test
    1. Create an empty job (no document data)                            [PASS]
        job-id (integer) = 1
        job-state (enum) = pending
    2. Does it show in Get-Jobs?                                         [PASS]
        job-name (nameWithoutLanguage) = KremboNet queue probe
        job-originating-user-name (nameWithoutLanguage) = krembonet
        job-id (integer) = 1
        job-state (enum) = pending
    3. Cancel it                                                         [PASS]
        status-code = successful-ok
```

The device reports `job-id`, `job-name`, `job-originating-user-name`,
`job-state`, and `job-state-reasons`. It does **not** return `job-impressions`
or a wall-clock submission time — `time-at-creation` counts seconds since
printer power-on, which is why `jobs.first_seen_at` is what the UI orders by.

A second pass through the full server confirmed end-to-end parsing, using a job
name chosen to break regex-based parsers:

```json
{ "jobId": 2,
  "name": "Level 2 Floor Plan, Rev \"C\" & Details",
  "user": "jdoe",
  "state": "pending" }
```

`Create-Job` is a safe way to exercise the queue on a production plotter — no
paper, no ink, and reversible with `Cancel-Job`. Note that `job-hold-until` is
**not** in `job-creation-attributes-supported`, so submitting a held job is not
an option here.

### Original observation

`Get-Jobs` returned zero job groups for **both** `not-completed` and
`completed` while the printer sat idle:

```console
$ ipptool -tv ipp://printer.example:631/ipp/print get-jobs.test
    ...  [PASS]
        RECEIVED: 72 bytes in response
        status-code = successful-ok
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
```

If your workstations print straight to the device rather than through a shared
print server, the device itself is the only place the queue exists — check with
`lpstat -v` to see which of the two your setup uses.

---

## Reproducing

Query files live in `server/test/fixtures/` and use ipptool's `$uri` variable,
so they work against any printer:

```bash
ipptool -tv ipp://printer.example:631/ipp/print server/test/fixtures/get-printer-attributes.test
```

To see what the server itself makes of a device:

```bash
npm run probe --workspace=@krembonet/server
```

To refresh the test fixtures after a firmware update:

```bash
ipptool -X ipp://printer.example:631/ipp/print \
  server/test/fixtures/get-printer-attributes.test \
  > server/test/fixtures/printer-attributes.plist
```
