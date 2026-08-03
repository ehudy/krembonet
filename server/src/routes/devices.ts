/**
 * Device management API.
 *
 * Everything here is behind `requireAdmin`, including the probe. That is a
 * deliberate choice rather than an oversight: a probe endpoint takes an
 * arbitrary address and makes the server connect to it, so leaving it open
 * would turn the hub into a network scanner for anyone who can reach it.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { clearAlertStateFor } from '../alerts/engine.js';
import { requireAdmin } from '../auth/session.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { DeviceError, type DeviceCapability } from '../devices/adapter.js';
import {
  mergeConfig,
  parseStoredConfig,
  readStoredConfig,
  redactConfig,
  serializeConfig,
  slugify,
  type RawConfig,
} from '../devices/config-io.js';
import { parseCidr } from '../devices/discovery/cidr.js';
import { DEFAULT_DISCOVER, discover } from '../devices/discovery/discover.js';
import { DEFAULT_SWEEP } from '../devices/discovery/scan.js';
import { smartProbe } from '../devices/discovery/smart-probe.js';
import { probeAll, suggestedAdapter } from '../devices/probe.js';
import { getAdapter, hasAdapter, listAdapters } from '../devices/registry.js';
import { clearCache } from '../poller/cache.js';
import { hydrateCacheFromDb, pollSupplies } from '../poller/pollDevice.js';

interface DeviceBody {
  displayName?: string;
  location?: string | null;
  adapter?: string;
  host?: string;
  enabled?: boolean;
  config?: RawConfig;
  capabilities?: string[] | null;
  isMuted?: boolean;
  muteSupplyAlerts?: boolean;
  muteMediaAlerts?: boolean;
  muteOfflineAlerts?: boolean;
}

/** Suppression flags, as booleans, from whatever the form sent. */
const MUTE_KEYS = [
  'isMuted',
  'muteSupplyAlerts',
  'muteMediaAlerts',
  'muteOfflineAlerts',
] as const;

function mutePatch(
  body: DeviceBody,
): Partial<Record<(typeof MUTE_KEYS)[number], boolean>> {
  const patch: Partial<Record<(typeof MUTE_KEYS)[number], boolean>> = {};
  for (const key of MUTE_KEYS) {
    if (body[key] !== undefined) patch[key] = body[key] === true;
  }
  return patch;
}

interface ProbeBody {
  host?: string;
  adapter?: string;
  config?: RawConfig;
}

interface DiscoverBody {
  subnet?: string;
  /** SNMP community to try during the sweep. Defaults to `public`. */
  community?: string;
}

function existingSlugs(exceptId?: number): Set<string> {
  return new Set(
    db
      .select({ id: devices.id, slug: devices.slug })
      .from(devices)
      .all()
      .filter((row) => row.id !== exceptId)
      .map((row) => row.slug),
  );
}

function presentDevice(row: typeof devices.$inferSelect) {
  const adapter = hasAdapter(row.adapter) ? getAdapter(row.adapter) : undefined;
  const stored = parseStoredConfig(row.config);

  const redacted =
    adapter === undefined
      ? { values: {}, secretsSet: [] }
      : redactConfig(adapter, stored);

  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    location: row.location,
    adapter: row.adapter,
    // Flagged rather than hidden: a device whose adapter no longer exists must
    // stay visible and deletable, not vanish from the list.
    adapterKnown: adapter !== undefined,
    host: row.host,
    enabled: row.enabled,
    vendor: row.vendor,
    model: row.model,
    serial: row.serial,
    capabilities:
      row.capabilities === null ? null : (JSON.parse(row.capabilities) as string[]),
    config: redacted.values,
    secretsSet: redacted.secretsSet,
    isMuted: row.isMuted,
    muteSupplyAlerts: row.muteSupplyAlerts,
    muteMediaAlerts: row.muteMediaAlerts,
    muteOfflineAlerts: row.muteOfflineAlerts,
  };
}

export async function deviceAdminRoutes(app: FastifyInstance): Promise<void> {
  /** Adapter list plus config schemas, which the admin form is generated from. */
  app.get('/api/admin/adapters', { preHandler: requireAdmin }, async () => ({
    adapters: listAdapters().map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      capabilities: adapter.capabilities,
      configSchema: adapter.configSchema,
    })),
  }));

  app.get('/api/admin/devices', { preHandler: requireAdmin }, async () => ({
    devices: db
      .select()
      .from(devices)
      .orderBy(devices.displayName)
      .all()
      .map(presentDevice),
  }));

  app.post<{ Body: ProbeBody }>(
    '/api/admin/devices/probe',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const host = String(request.body?.host ?? '').trim();
      if (host === '') {
        return reply.code(400).send({ error: 'An address is required.' });
      }

      const adapterId = request.body?.adapter;
      if (adapterId !== undefined && !hasAdapter(adapterId)) {
        return reply.code(400).send({ error: `Unknown adapter "${adapterId}".` });
      }

      const results = await probeAll(host, request.body?.config ?? {}, adapterId);

      return { host, results, suggested: suggestedAdapter(results) };
    },
  );

  /**
   * What one address speaks, before an adapter has been chosen.
   *
   * Distinct from the probe above, which asks "does this adapter recognise this
   * config" — that assumes someone already picked both. This asks the question
   * that comes first, and answers it by trying every protocol the hub can use.
   *
   * Admin-only for the same reason the probe and the sweep are: it makes the
   * server open connections to an arbitrary address, which is a capability worth
   * keeping behind the sign-in whatever it is called.
   */
  app.post<{ Body: { address?: string; community?: string } }>(
    '/api/admin/devices/smart-probe',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const address = String(request.body?.address ?? '').trim();
      if (address === '') {
        return reply.code(400).send({ error: 'An address is required.' });
      }

      const community =
        String(request.body?.community ?? '').trim() || DEFAULT_SWEEP.community;

      const result = await smartProbe(address, community);

      request.log.info(
        { host: address, adapter: result.adapter, reachable: result.reachable },
        'smart probe finished',
      );

      return result;
    },
  );

  /**
   * Sweeps a subnet and identifies whatever answers.
   *
   * Admin-only for the same reason the probe is, and more so: this makes the
   * server connect to every address in a range, which is a port scanner by any
   * other name. It is bounded on every axis — subnet size, per-host timeout,
   * concurrency, how many hosts get probed, and a total deadline — so it cannot
   * be turned into a long-running load generator against someone's network.
   */
  app.post<{ Body: DiscoverBody }>(
    '/api/admin/devices/discover',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = parseCidr(String(request.body?.subnet ?? ''));
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

      const { subnet } = parsed;

      // A LAN tool sweeping a public range is either a mistake or something
      // that gets an address blocked. Refused by default, with an escape hatch
      // for the networks that genuinely use public space internally.
      if (!subnet.isPrivate && !config.discovery.allowPublicRanges) {
        return reply.code(400).send({
          error: `${subnet.cidr} is outside the private address ranges. If this really is your own network, set DISCOVERY_ALLOW_PUBLIC_RANGES=true.`,
        });
      }

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), config.discovery.deadlineMs);

      try {
        const result = await discover(subnet.hosts, {
          ...DEFAULT_SWEEP,
          ...DEFAULT_DISCOVER,
          community:
            String(request.body?.community ?? '').trim() || DEFAULT_SWEEP.community,
          knownHosts: new Set(
            db
              .select({ host: devices.host })
              .from(devices)
              .all()
              .map((row) => row.host),
          ),
          signal: controller.signal,
        });

        request.log.info(
          { subnet: subnet.cidr, scanned: result.scanned, found: result.devices.length },
          'subnet discovery finished',
        );

        return {
          subnet: subnet.cidr,
          hostCount: subnet.hosts.length,
          // True when the deadline cut the sweep short, so the UI can say the
          // list is partial rather than presenting it as the whole network.
          timedOut: controller.signal.aborted,
          ...result,
        };
      } finally {
        clearTimeout(deadline);
      }
    },
  );

  app.post<{ Body: DeviceBody }>(
    '/api/admin/devices',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = request.body ?? {};
      const displayName = String(body.displayName ?? '').trim();
      const host = String(body.host ?? '').trim();
      const adapterId = String(body.adapter ?? '').trim();

      if (displayName === '') {
        return reply.code(400).send({ error: 'A display name is required.' });
      }
      if (host === '') return reply.code(400).send({ error: 'An address is required.' });
      if (!hasAdapter(adapterId)) {
        return reply.code(400).send({ error: `Unknown adapter "${adapterId}".` });
      }

      const adapter = getAdapter(adapterId);
      let normalized: RawConfig;
      try {
        // Parse to validate, but store what was submitted: the adapter's parsed
        // shape is its own business and may not round-trip.
        adapter.parseConfig(body.config ?? {});
        normalized = body.config ?? {};
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof DeviceError ? error.message : String(error) });
      }

      const slug = slugify(displayName, existingSlugs());

      const [created] = db
        .insert(devices)
        .values({
          slug,
          displayName,
          location:
            body.location === undefined || body.location === null || body.location === ''
              ? null
              : String(body.location).trim(),
          adapter: adapterId,
          host,
          config: serializeConfig(adapter, normalized),
          enabled: body.enabled !== false,
          ...mutePatch(body),
          capabilities:
            body.capabilities === undefined || body.capabilities === null
              ? null
              : JSON.stringify(body.capabilities),
        })
        .returning()
        .all();

      if (created === undefined) {
        return reply.code(500).send({ error: 'Could not create the device.' });
      }

      // Populate the cache immediately so the new device is not a blank card
      // until the next background tick. A failure here is not a failure to
      // create — the dashboard will show it as unreachable, which is accurate.
      try {
        await pollSupplies(created);
      } catch {
        hydrateCacheFromDb();
      }

      request.log.info({ slug, adapter: adapterId }, 'device added');
      return reply.code(201).send(presentDevice(created));
    },
  );

  app.put<{ Params: { id: string }; Body: DeviceBody }>(
    '/api/admin/devices/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const [existing] = db.select().from(devices).where(eq(devices.id, id)).all();
      if (existing === undefined) {
        return reply.code(404).send({ error: 'No such device.' });
      }

      const body = request.body ?? {};
      const adapterId = String(body.adapter ?? existing.adapter);
      if (!hasAdapter(adapterId)) {
        return reply.code(400).send({ error: `Unknown adapter "${adapterId}".` });
      }
      const adapter = getAdapter(adapterId);

      const displayName =
        body.displayName === undefined
          ? existing.displayName
          : String(body.displayName).trim();
      if (displayName === '') {
        return reply.code(400).send({ error: 'A display name is required.' });
      }

      const host = body.host === undefined ? existing.host : String(body.host).trim();
      if (host === '') return reply.code(400).send({ error: 'An address is required.' });

      // Blank secrets in the submission fall back to what is stored, so saving
      // the form without retyping a community string keeps it. Read decrypted,
      // because `parseConfig` below validates the real values — an SNMPv3 key
      // still in its envelope would pass a length check it should not.
      const stored = readStoredConfig(adapter, existing.config);
      const merged =
        body.config === undefined ? stored : mergeConfig(adapter, stored, body.config);

      try {
        adapter.parseConfig(merged);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof DeviceError ? error.message : String(error) });
      }

      db.update(devices)
        .set({
          displayName,
          location:
            body.location === undefined
              ? existing.location
              : body.location === null || body.location === ''
                ? null
                : String(body.location).trim(),
          adapter: adapterId,
          host,
          config: serializeConfig(adapter, merged),
          enabled: body.enabled === undefined ? existing.enabled : body.enabled !== false,
          ...mutePatch(body),
          capabilities:
            body.capabilities === undefined
              ? existing.capabilities
              : body.capabilities === null
                ? null
                : JSON.stringify(body.capabilities),
          updatedAt: new Date(),
        })
        .where(eq(devices.id, id))
        .run();

      const [updated] = db.select().from(devices).where(eq(devices.id, id)).all();

      // Connection details may have changed, so the cached reading is no longer
      // trustworthy. Rebuilding from the database is cheap and correct.
      clearCache();
      hydrateCacheFromDb();

      request.log.info({ slug: existing.slug }, 'device updated');
      return presentDevice(updated as typeof devices.$inferSelect);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/devices/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const [existing] = db.select().from(devices).where(eq(devices.id, id)).all();
      if (existing === undefined) {
        return reply.code(404).send({ error: 'No such device.' });
      }

      // Supplies, history, media and jobs cascade; alert logs keep their rows
      // with a null device so the audit trail survives the device.
      // Alert state is keyed by slug, so a device re-added under the same name
      // would otherwise start out believing it is already alerting — and never
      // announce the next real crossing.
      clearAlertStateFor(existing.slug);
      db.delete(devices).where(eq(devices.id, id)).run();

      clearCache();
      hydrateCacheFromDb();

      request.log.warn({ slug: existing.slug }, 'device deleted');
      return { ok: true };
    },
  );
}

export type { DeviceCapability };
