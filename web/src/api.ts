/**
 * Thin fetch wrapper.
 *
 * Every call goes to the same origin, so cookies ride along automatically and
 * there is no CORS or token handling to get wrong.
 */
import type {
  AdapterInfo,
  AdminDevice,
  AdminSettings,
  AlertLogRow,
  AlertStateRow,
  MediaType,
  DeviceListResponse,
  DeviceStatus,
  ProbeResponse,
  SessionInfo,
  SetupStatus,
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
  /** Operator-configured hub name. Unauthenticated — the shell needs it first. */
  getHub: (signal?: AbortSignal) => request<{ title: string }>('/api/hub', { signal }),

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

  setupStatus: (signal?: AbortSignal) => request<SetupStatus>('/api/setup', { signal }),

  completeSetup: (body: { password: string; confirmPassword: string; hubTitle: string }) =>
    request<{ ok: true }>('/api/setup', { method: 'POST', body: JSON.stringify(body) }),

  session: (signal?: AbortSignal) => request<SessionInfo>('/api/admin/session', { signal }),

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

  saveMediaType: (code: string, friendlyName: string) =>
    request<{ ok: true }>(`/api/admin/media-types/${encodeURIComponent(code)}`, {
      method: 'PUT',
      body: JSON.stringify({ friendlyName }),
    }),

  deleteMediaType: (code: string) =>
    request<{ ok: true }>(`/api/admin/media-types/${encodeURIComponent(code)}`, {
      method: 'DELETE',
    }),

  listAdapters: (signal?: AbortSignal) =>
    request<{ adapters: AdapterInfo[] }>('/api/admin/adapters', { signal }),

  listAdminDevices: (signal?: AbortSignal) =>
    request<{ devices: AdminDevice[] }>('/api/admin/devices', { signal }),

  probeDevice: (body: { host: string; adapter?: string; config?: Record<string, unknown> }) =>
    request<ProbeResponse>('/api/admin/devices/probe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createDevice: (body: Record<string, unknown>) =>
    request<AdminDevice>('/api/admin/devices', { method: 'POST', body: JSON.stringify(body) }),

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
};
