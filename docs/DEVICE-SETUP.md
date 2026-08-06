# Device setup guides

Krembonet is a read-only monitor. It needs each device to answer, unauthenticated,
on IPP (`631`) or SNMP (`161`) — IPP for the fuller picture (supplies, media,
state, **and the print queue**), SNMP as a fallback that reports everything except
the queue.

The goal on every device is the same: turn on IPP and/or SNMP v2c read access,
scoped to the hub, and reboot the network controller so the change takes. The
vendor sections below point at where each setting lives. Menu paths vary by model
and firmware; treat them as "look near here", not exact.

> [!NOTE]
> After changing any network or IPP setting, **reboot the device's network
> controller** (a soft restart from the panel). Most enterprise MFPs apply these
> changes only on restart, and skipping it is the single most common reason a
> correct change appears not to work. Then confirm from **Admin → Devices → Edit →
> Test connection**.

---

## What "working" looks like

After setup, a probe from **Admin → Devices** should report:

- **IPP:** `reachability, supplies, media, jobs` — the full set. `jobs` is the one
  that proves unauthenticated `Get-Jobs` is allowed.
- **SNMP:** `reachability, supplies, media` — no `jobs`, and that is expected;
  SNMP cannot report a queue.

If IPP answers for supplies but not `jobs`, see
[Print queues and IPP status refusals](TROUBLESHOOTING.md) — it is an
authentication-scope setting plus a reboot, not a wiring problem.

---

## Sharp

**IPP status queries**
- **Settings → Network Settings → Services / Print Port Settings** — enable **IPP**
  (and, on many models, "Raw"/LPD is separate and not needed here).
- **Application Port / IPP security:** allow status queries without login. Sharp
  often gates IPP behind the same "Print Release" / authentication policy used for
  pull-printing; that policy governs *submitting* a job and can stay on — Krembonet
  only reads.

**SNMP**
- **Network Settings → SNMP Settings** — enable **SNMP v1/v2c**, set the **read**
  community (default `public`; match whatever your fleet uses), and permit the
  hub's address.

**AirPrint**
- Enabling **AirPrint** (Bonjour/mDNS) turns on a standards-compliant IPP stack,
  which is often the quickest way to get clean `Get-Printer-Attributes` and
  `Get-Jobs` answers on a Sharp MFP. Safe to leave on alongside monitoring.

---

## Canon (imageRUNNER / imagePROGRAF)

**IPP status queries**
- **Settings/Registration → Network → TCP/IP Settings → IPP Print Settings** —
  enable **IPP**. If **Use Authentication** is on, IPP submission requires a login;
  status reads should still be permitted, but if `Get-Jobs` is refused, this is the
  box to revisit.

> [!IMPORTANT]
> On Canon, allowing IPP status reads is independent of **Department ID
> Management**. Department IDs and per-department quotas apply when a job is
> printed and are unaffected by letting Krembonet read the queue. You do not have
> to weaken accounting to get monitoring.

**SNMP**
- **Network → SNMP Settings** — enable **SNMP v1** (Canon's v2c support varies by
  model), set the read community, and scope it to the hub.

**AirPrint / Mopria**
- **Network → AirPrint Settings** — enabling AirPrint exposes the IPP everywhere
  interface and generally improves the quality of IPP status answers.

**Large-format note (imagePROGRAF / TZ / TX plotters):** roll media reports over
IPP but remaining roll *length* is not exposed by any vendor-neutral attribute, so
the paper panel shows the loaded roll and width, not a metres-remaining figure.
That is a device limitation, not a missing feature. See
`docs/canon-tz32000-field-notes.md` for the captured behaviour behind several of
the parsing decisions.

---

## Xerox (VersaLink / AltaLink / WorkCentre)

**IPP status queries**
- **Properties → Connectivity → Setup → IPP** (or Protocols → IPP) — enable it.
- **Accounting/permissions:** Xerox ties IPP into its login and accounting policy.
  Leave accounting on for *printing*; ensure the policy does not require
  authentication for the **status/queue read** specifically.

**SNMP**
- **Properties → Connectivity → SNMP** — enable **SNMP v2c**, set the **GET**
  community string, and add the hub to the access list. Xerox lets you set
  distinct GET/SET communities; Krembonet only ever GETs.

**AirPrint**
- **Connectivity → AirPrint** — turning it on enables the IPP-everywhere stack and
  is a reliable way to get complete `Get-Printer-Attributes` responses.

---

## HP (LaserJet / PageWide / DesignJet)

**IPP status queries**
- **EWS (the printer's web page) → Networking → IPP / IPP Everywhere** — enable it.
- **Networking → Access Control / IPSec-Firewall:** if you use HP's firewall rules,
  add the hub's address to what may reach IPP (`631`) and SNMP (`161`).

**SNMP**
- **Networking → SNMP** — enable **SNMPv1/v2c** read-only, set the community, and
  restrict it to the hub. HP defaults to allowing SNMPv1/v2 read with `public`;
  hardened images disable it, which then reads as a timeout.

**AirPrint**
- HP enables AirPrint by default on most current firmware; if IPP answers are
  incomplete, confirm **Networking → AirPrint** is on.

**DesignJet (large-format):** as with other plotters, supplies and loaded media
report over IPP, but remaining roll length is not a vendor-neutral attribute and is
not shown.

---

## After setup: verify

1. **Admin → Devices → Add device** (or Edit an existing one).
2. Enter the address and use **Probe IP** to let the hub identify the protocol, or
   pick the adapter and fill the connection fields yourself.
3. **Test connection.** Read the capability line and the notes: they tell you
   exactly what answered and what did not — including "trays report low/OK only" or
   "Get-Jobs was refused", so you find out now rather than a week later when an
   alert does not arrive.
4. Save. The device appears on the dashboard with panels for what it actually
   reports.
