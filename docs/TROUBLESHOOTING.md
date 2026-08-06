# Troubleshooting

Field guide for the operational problems that actually come up: a printer that
answers but shows no queue, supply levels that read as low/OK instead of a
percentage, addresses that drift overnight, and the handful of host-level knobs
(reverse proxy, SQLite) worth knowing about.

Every section below is written against how Krembonet actually behaves, not how a
generic print server might. Where a setting only affects one vendor, it says so.

---

## Print queues and IPP status refusals

**Symptom:** A device is reachable, supplies and paper show up, but the print
queue panel never appears — or a probe reports *"Get-Jobs was refused, so the
print queue will not be shown."*

**What is happening:** The queue is the one thing only IPP can report; SNMP's Job
Monitoring MIB (RFC 2707) is effectively never implemented, so no queue means the
IPP `Get-Jobs` operation was refused. Enterprise MFPs from **Sharp, Xerox, Canon,
and HP** frequently answer `Get-Printer-Attributes` (supplies, media, state)
happily while rejecting `Get-Jobs` from an unauthenticated caller — usually as an
HTTP `401`, sometimes as an IPP `client-error-forbidden`. The device is working;
its security policy is simply narrower for the queue than for status.

Krembonet never authenticates to a device, by design (it is a read-only monitor
with no stored device credentials). So the fix is on the printer: allow
unauthenticated IPP status queries.

> [!NOTE]
> **Allowing IPP status reads does not disable accounting.** Unchecking an "IPP
> authentication" or "require authentication for IPP" box lets Krembonet *read*
> the queue. It does **not** bypass Canon Department IDs, Xerox accounting, or
> per-user quotas that apply when someone actually *submits* a job. Read access
> and print authorisation are separate gates on every platform we have seen.

Per vendor, the setting to look for:

| Vendor | Where the restriction usually lives |
| --- | --- |
| Sharp | System Settings → Network → IPP / "Print Release" and Application Port security |
| Xerox | Properties → Connectivity → IPP, and the "Login/Permissions" accounting rules |
| Canon | Settings/Registration → Network → IPP Print Settings → "Use Authentication" |
| HP | EWS → Networking → IPP / "Access Control" and IPSec/Firewall rules |

> [!WARNING]
> **A soft reboot is usually mandatory.** Most enterprise MFPs apply IPP and
> network-security changes only after a restart of the network controller — a
> normal "restart" or "soft reboot" from the panel, not a hard power cycle. Until
> then a probe keeps reporting the old behaviour, which reads as "the fix did not
> work". Reboot, then re-probe from **Admin → Devices → Edit → Test connection**.

Once the device allows it, re-probe. A successful `Get-Jobs` adds the `jobs`
capability and the queue panel appears on the device page. See
[Poller loop and capability management](#poller-loop-and-capability-management)
for why a re-probe — rather than a wait — is what clears the earlier refusal.

---

## SNMP and supply levels

**Symptom:** A device polls fine but a toner or a tray reads *low* / *ok* instead
of a percentage, or a custom community string is rejected.

**Custom v2c community strings.** Krembonet defaults to the `public` read
community. A hardened fleet will have changed it. Set the device's community in
**Admin → Devices → Edit** under the SNMP adapter's connection fields; a wrong or
empty community produces a timeout that looks exactly like an unreachable host, so
rule the community out first when SNMP "cannot connect" but ping works.

> [!NOTE]
> Krembonet reads SNMP v2c (and v1). It does not use SNMP v3. A device locked to
> v3-only will not answer — enable v2c read-only, scoped to the hub's address, or
> use the device's IPP interface instead.

**Boolean vs. percentage supply OIDs.** RFC 3805 lets a device report a supply
level as a real capacity (`prtMarkerSuppliesLevel` against `MaxCapacity`) *or* as
one of two sentinels meaning "some remaining" / "unknown". Cheaper engines, and
most waste receptacles, report only the sentinel. Krembonet surfaces that
honestly:

- **percent** — a real level against a real maximum.
- **ok / low (binary)** — the device only reports a threshold flag, so that is
  all the panel shows. It is not a bug or a rounding — the number does not exist
  on the wire.
- **not reported (unknown)** — the device declined to say. Alerting **skips**
  these rather than treating them as `0%`, because a fabricated zero would page
  someone at 2am over a supply that is fine.

If a supply you expect as a percentage shows as low/OK, the device is reporting
the sentinel form; there is no vendor-neutral OID that turns it into a number.

---

## Network and connectivity

**Ports Krembonet needs outbound to each device:**

| Port | Protocol | Used for |
| --- | --- | --- |
| `631` | IPP (TCP) | Supplies, media, device state, and the print queue |
| `161` | SNMP (UDP) | Supplies, media, and device state on non-IPP devices |
| `80` / `443` | HTTP(S) (TCP) | The "Open web console" link to the printer's own EWS, and smart-probe identification |

The hub's own web UI is served on its configured HTTP port (behind your reverse
proxy if you use one — see below). Devices are polled *from* the hub, so it is the
hub that needs to reach `631`/`161` on each printer, not the other way round.

> [!TIP]
> **DHCP address drift is the most common "it stopped working overnight".** A
> printer that grabs a new lease answers on a new address while Krembonet keeps
> polling the old one, which then reads as offline. Give every monitored device a
> **DHCP reservation** or a static address. When a device goes offline for no
> obvious reason, check its current IP at the panel before anything else; if it
> moved, update the host in **Admin → Devices → Edit**.

---

## Poller loop and capability management

Krembonet has exactly one component that talks to a device — the poller — and the
HTTP API only ever reads its cache. Understanding three of its behaviours explains
most "why is it showing that" questions.

**Capabilities are declared at probe time, then trusted.** When you add or probe a
device, the adapter records what it *actually answered* — `reachability`,
`supplies`, `media`, `jobs` — and the dashboard renders panels for exactly those.
A device that refused `Get-Jobs` during the probe has no `jobs` capability, so the
poller never asks it for a queue again and no empty queue panel is drawn.

> [!IMPORTANT]
> **A refusal is remembered until you re-probe.** Because the capability set is
> stored, fixing the printer (allowing IPP status, rebooting) does **not** make
> the queue appear on its own — the poller is still working from the capability
> list captured when the device last refused. Re-probe from **Admin → Devices →
> Edit → Test connection** and save; that re-runs `Get-Jobs` and, on success,
> adds the `jobs` capability. Separately, the IPP adapter keeps an in-process note
> of any device that refused the *completed-jobs* history lookup and stops asking
> that one device for the rest of the process; restarting the hub clears that note.

**Two cadences, not one.** Supplies, media, and device state are read on a
background timer (hourly by default, configurable in **Admin → Settings**), which
is also when alerts are evaluated — so it runs whether or not a browser is open.
The print **queue** is refreshed on demand behind a short TTL, and an open device
page polls it about once a minute. A closed dashboard does not refresh queues.

**Finished jobs linger, on purpose.** IPP spoolers drop a job from the active
queue the instant the file finishes uploading, while the engine keeps printing —
minutes, on a large-format plot. Krembonet keeps such a job visible, marked
*"Finishing"*, until the device reports it is idle again. A safety valve
(`MAX_LINGER_MS`, 30 minutes) releases a job whose printer never returns to idle,
so a stuck job cannot haunt the queue forever. If a job seems to hang in
"Finishing", confirm the device's own state first — a device wedged in
`processing` is a device problem, and the 30-minute cap is what bounds its effect
here.

---

## Reverse proxies

Krembonet's browser UI talks to its own API over ordinary request/response HTTP,
polling on a timer. **It does not use Server-Sent Events or WebSockets**, so the
usual "disable proxy buffering for streaming" advice does not apply — there is no
long-lived connection to keep unbuffered, and a default proxy configuration works.

What does matter behind a proxy:

- **Pass the real client address** (`X-Forwarded-For` / `X-Forwarded-Proto`) if
  you rely on it in logs.
- **Do not add aggressive response caching** in front of `/api` — the poll
  responses are meant to be read fresh each time. Cache the static assets, not the
  API.
- **Give device reads time.** A slow printer can take a few seconds to answer a
  poll; keep the proxy's upstream read timeout comfortably above the device
  timeout so a legitimately slow read is not cut off as a 502.

> [!NOTE]
> If you are adapting a config template written for a streaming app, the
> `proxy_buffering off;` line (nginx) or its Caddy/Cloudflare equivalent is
> harmless here but unnecessary. Krembonet needs no special buffering, upgrade, or
> `Connection` handling.

**nginx** — a minimal, correct front for the hub:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Comfortably above the device timeout, so a slow printer is not cut off.
    proxy_read_timeout 30s;
}
```

**Caddy** — the whole file:

```caddy
hub.example.internal {
    reverse_proxy 127.0.0.1:3000
}
```

**Cloudflare** — proxying works with defaults. Leave "Caching" on Standard (it
respects the API's no-store responses) and there is nothing streaming to exempt.

---

## Database and system health

Krembonet stores its cache and history in a single SQLite file
(`data/krembonet.db`), opened in **WAL** mode so the HTTP handlers can read while
the poller writes.

**`SQLITE_BUSY` in the logs.** WAL removes almost all reader/writer contention,
but a `SQLITE_BUSY` can still surface if a second process opens the same file — the
classic cause is **two hub instances pointed at one database** (for example a
stray container from a previous deploy, or a host process and a container sharing a
mounted volume). SQLite is single-writer; run **one** hub per database file. The
connection is opened with a busy timeout, so a brief overlap retries rather than
failing, but sustained `SQLITE_BUSY` means two writers.

> [!WARNING]
> **Do not put the database on a network share.** SQLite's locking is unreliable
> over NFS/SMB, and WAL specifically requires that all readers and writers see the
> same file on local storage. Keep `data/` on a local disk or a normal container
> volume.

**WAL housekeeping.** You may see `-wal` and `-shm` companion files next to the
database — that is normal and they are not safe to delete while the hub is
running. If you back the database up, either stop the hub first or use SQLite's
online backup / `VACUUM INTO`; copying the `.db` file alone while the hub runs can
miss data still in the `-wal`.

**A corrupt or unreadable database** (wrong `ENCRYPTION_KEY` for stored device
secrets shows as devices going unreachable with a config error, not as corruption)
is recoverable from your backups; the only data that cannot be re-read from a
device is the supply-level history, which is why that table is the one worth
backing up.
