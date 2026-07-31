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

import { requireAdmin } from '../auth/session.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { DeviceError, type DeviceCapability, type ProbeResult } from '../devices/adapter.js';
import {
  mergeConfig,
  parseStoredConfig,
  redactConfig,
  slugify,
  type RawConfig,
} from '../devices/config-io.js';
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
}

interface ProbeBody {
  host?: string;
  adapter?: string;
  config?: RawConfig;
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
    capabilities: row.capabilities === null ? null : (JSON.parse(row.capabilities) as string[]),
    config: redacted.values,
    secretsSet: redacted.secretsSet,
  };
}

/** Ranks adapters by how confident each is that it recognises the device. */
async function probeAll(
  host: string,
  rawConfig: RawConfig,
  adapterId?: string,
): Promise<{ adapter: string; label: string; result: ProbeResult }[]> {
  const candidates =
    adapterId === undefined ? listAdapters() : [getAdapter(adapterId)];

  const results: { adapter: string; label: string; result: ProbeResult }[] = [];

  for (const adapter of candidates) {
    try {
      const parsed = adapter.parseConfig(rawConfig);
      const result = await adapter.probe(parsed, {
        timeoutMs: config.deviceTimeoutMs,
        host,
      });
      results.push({ adapter: adapter.id, label: adapter.label, result });
    } catch (error) {
      // A config the adapter cannot even parse is a legitimate outcome when
      // probing every adapter at once — the IPP adapter needs a URI the SNMP
      // form never collects. Report it rather than failing the whole probe.
      const message =
        error instanceof DeviceError ? error.message : String(error);
      results.push({
        adapter: adapter.id,
        label: adapter.label,
        result: {
          reachable: false,
          confidence: 0,
          identity: { vendor: null, makeAndModel: null, serial: null, firmware: null },
          capabilities: [],
          notes: [message],
        },
      });
    }
  }

  return results.sort((a, b) => b.result.confidence - a.result.confidence);
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
    devices: db.select().from(devices).orderBy(devices.displayName).all().map(presentDevice),
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
      const best = results[0];

      return {
        host,
        results,
        // Only a suggestion. The admin picks, because a probe that guesses
        // wrong and silently commits is worse than one that asks.
        suggested:
          best !== undefined && best.result.reachable && best.result.confidence > 0
            ? best.adapter
            : null,
      };
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
          location: body.location === undefined || body.location === null || body.location === ''
            ? null
            : String(body.location).trim(),
          adapter: adapterId,
          host,
          config: JSON.stringify(normalized),
          enabled: body.enabled !== false,
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
        body.displayName === undefined ? existing.displayName : String(body.displayName).trim();
      if (displayName === '') {
        return reply.code(400).send({ error: 'A display name is required.' });
      }

      const host = body.host === undefined ? existing.host : String(body.host).trim();
      if (host === '') return reply.code(400).send({ error: 'An address is required.' });

      // Blank secrets in the submission fall back to what is stored, so saving
      // the form without retyping a community string keeps it.
      const merged =
        body.config === undefined
          ? parseStoredConfig(existing.config)
          : mergeConfig(adapter, parseStoredConfig(existing.config), body.config);

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
          config: JSON.stringify(merged),
          enabled: body.enabled === undefined ? existing.enabled : body.enabled !== false,
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
      db.delete(devices).where(eq(devices.id, id)).run();

      clearCache();
      hydrateCacheFromDb();

      request.log.warn({ slug: existing.slug }, 'device deleted');
      return { ok: true };
    },
  );
}

export type { DeviceCapability };
