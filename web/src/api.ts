/**
 * Thin fetch wrapper.
 *
 * Every call goes to the same origin, so cookies ride along automatically and
 * there is no CORS or token handling to get wrong.
 */
import type {
  AccessStatus,
  ActivityEventType,
  ActivityResponse,
  AdapterInfo,
  AdminDevice,
  AdminSettings,
  AlertLogRow,
  AlertStateRow,
  DiscoveredMediaCode,
  HubBranding,
  MediaCatalogResponse,
  MediaType,
  DeviceListResponse,
  DeviceStatus,
  DiscoveryResponse,
  LocalSubnet,
  ProbeResponse,
  SmartProbeResponse,
  SessionInfo,
  SetupStatus,
  SupplyMatrixResponse,
  Webhook,
  WebhookFormat,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // Non-JSON error body; the status-based message is the best we have.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export const api = {
  /**
   * Hub name, theme, and custom CSS. Unauthenticated — the shell renders itself
   * before anyone has signed in or entered a passcode.
   */
  getHub: (signal?: AbortSignal) => request<HubBranding>('/api/hub', { signal }),

  /** Whether this browser may read the dashboard. Unauthenticated by necessity. */
  access: (signal?: AbortSignal) => request<AccessStatus>('/api/access', { signal }),

  unlock: (passcode: string) =>
    request<{ ok: true }>('/api/access/unlock', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),

  lock: () => request<{ ok: true }>('/api/access/lock', { method: 'POST' }),

  listDevices: (signal?: AbortSignal) =>
    request<DeviceListResponse>('/api/devices', { signal }),

  /**
   * `refresh: 'jobs'` is the cadence an open dashboard uses: it keeps the queue
   * live without pulling ink and paper every minute, since those sit on the
   * hourly background poll.
   */
  deviceStatus: (slug: string, options?: { refresh?: 'jobs'; signal?: AbortSignal }) =>
    request<DeviceStatus>(
      `/api/printers/${encodeURIComponent(slug)}/status${
        options?.refresh === 'jobs' ? '?refresh=jobs' : ''
      }`,
      { signal: options?.signal },
    ),

  /** Every supply on every device, for the re-order matrix and the Overview widget. */
  listSupplies: (signal?: AbortSignal) =>
    request<SupplyMatrixResponse>('/api/supplies', { signal }),

  /** Loaded paper stock across the fleet. */
  listMedia: (signal?: AbortSignal) =>
    request<MediaCatalogResponse>('/api/media', { signal }),

  /**
   * The event timeline, newest first.
   *
   * `types` filters server-side rather than in the browser so a narrow filter
   * over a long history still returns a full page of matching rows, instead of
   * whatever survived filtering the most recent fifty.
   */
  activity: (
    options?: { limit?: number; types?: readonly ActivityEventType[] },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (options?.limit !== undefined) query.set('limit', String(options.limit));
    for (const type of options?.types ?? []) query.append('type', type);

    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return request<ActivityResponse>(`/api/activity${suffix}`, { signal });
  },

  setupStatus: (signal?: AbortSignal) => request<SetupStatus>('/api/setup', { signal }),

  completeSetup: (body: {
    password: string;
    confirmPassword: string;
    hubTitle: string;
  }) =>
    request<{ ok: true }>('/api/setup', { method: 'POST', body: JSON.stringify(body) }),

  session: (signal?: AbortSignal) =>
    request<SessionInfo>('/api/admin/session', { signal }),

  login: (password: string) =>
    request<{ ok: true }>('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),

  getSettings: (signal?: AbortSignal) =>
    request<AdminSettings>('/api/admin/settings', { signal }),

  saveSettings: (patch: Record<string, unknown>) =>
    request<AdminSettings>('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  sendTestEmail: () =>
    request<{ ok: boolean; recipients?: string[] }>('/api/admin/settings/test-email', {
      method: 'POST',
    }),

  listMediaTypes: (signal?: AbortSignal) =>
    request<{ mediaTypes: MediaType[] }>('/api/admin/media-types', { signal }),

  /** Raw paper codes the printers are reporting, so unnamed ones can be found. */
  discoveredMediaCodes: (signal?: AbortSignal) =>
    request<{ discovered: DiscoveredMediaCode[] }>(
      '/api/admin/media-types/discovered',
      { signal },
    ),

  /**
   * Names a code. `deviceId` scopes it: null (or omitted) is the global name,
   * a device id is an override that wins for that device only.
   */
  saveMediaType: (code: string, friendlyName: string, deviceId: number | null = null) =>
    request<{ ok: true }>(`/api/admin/media-types/${encodeURIComponent(code)}`, {
      method: 'PUT',
      body: JSON.stringify({ friendlyName, deviceId }),
    }),

  /** Deletes one mapping by its row id — a code can name several scopes at once. */
  deleteMediaType: (id: number) =>
    request<{ ok: true }>(`/api/admin/media-types/${id}`, {
      method: 'DELETE',
    }),

  listAdapters: (signal?: AbortSignal) =>
    request<{ adapters: AdapterInfo[] }>('/api/admin/adapters', { signal }),

  listAdminDevices: (signal?: AbortSignal) =>
    request<{ devices: AdminDevice[] }>('/api/admin/devices', { signal }),

  probeDevice: (body: {
    host: string;
    adapter?: string;
    config?: Record<string, unknown>;
  }) =>
    request<ProbeResponse>('/api/admin/devices/probe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Works out what one address speaks, before an adapter has been chosen.
   *
   * Tries IPP, both community SNMP versions, and the web ports, and comes back
   * with the adapter and config to use. Takes a second or two — every protocol
   * that does not answer costs a timeout.
   */
  smartProbe: (body: { address: string; community?: string }, signal?: AbortSignal) =>
    request<SmartProbeResponse>('/api/admin/devices/smart-probe', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  /** The hub's own subnet, to pre-fill the sweep field. Null when unknown. */
  defaultSubnet: (signal?: AbortSignal) =>
    request<{ subnet: LocalSubnet | null }>('/api/admin/devices/default-subnet', {
      signal,
    }),

  /**
   * Sweeps a subnet. Slow by nature — a /24 takes several seconds — so callers
   * should show progress and pass a signal they can abort.
   */
  discoverDevices: (body: { subnet: string; community?: string }, signal?: AbortSignal) =>
    request<DiscoveryResponse>('/api/admin/devices/discover', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  createDevice: (body: Record<string, unknown>) =>
    request<AdminDevice>('/api/admin/devices', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateDevice: (id: number, body: Record<string, unknown>) =>
    request<AdminDevice>(`/api/admin/devices/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteDevice: (id: number) =>
    request<{ ok: true }>(`/api/admin/devices/${id}`, { method: 'DELETE' }),

  alerts: (signal?: AbortSignal) =>
    request<{ active: AlertStateRow[]; recent: AlertLogRow[] }>('/api/admin/alerts', {
      signal,
    }),

  listWebhooks: (signal?: AbortSignal) =>
    request<{
      formats: { id: WebhookFormat; label: string }[];
      webhooks: Webhook[];
    }>('/api/admin/webhooks', { signal }),

  createWebhook: (body: Record<string, unknown>) =>
    request<Webhook>('/api/admin/webhooks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateWebhook: (id: number, body: Record<string, unknown>) =>
    request<Webhook>(`/api/admin/webhooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteWebhook: (id: number) =>
    request<{ ok: true }>(`/api/admin/webhooks/${id}`, { method: 'DELETE' }),

  testWebhook: (id: number) =>
    request<{ ok: boolean; status?: number | null }>(`/api/admin/webhooks/${id}/test`, {
      method: 'POST',
    }),
};
