/**
 * Thin fetch wrapper.
 *
 * Every call goes to the same origin, so cookies ride along automatically and
 * there is no CORS or token handling to get wrong.
 */
import type {
  AdminSettings,
  AlertLogRow,
  AlertStateRow,
  MediaType,
  PrinterListResponse,
  PrinterStatus,
  SessionInfo,
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

  listPrinters: (signal?: AbortSignal) =>
    request<PrinterListResponse>('/api/printers', { signal }),

  /**
   * `refresh: 'jobs'` is the cadence an open dashboard uses: it keeps the queue
   * live without pulling ink and paper every minute, since those sit on the
   * hourly background poll.
   */
  printerStatus: (slug: string, options?: { refresh?: 'jobs'; signal?: AbortSignal }) =>
    request<PrinterStatus>(
      `/api/printers/${encodeURIComponent(slug)}/status${
        options?.refresh === 'jobs' ? '?refresh=jobs' : ''
      }`,
      { signal: options?.signal },
    ),

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

  alerts: (signal?: AbortSignal) =>
    request<{ active: AlertStateRow[]; recent: AlertLogRow[] }>('/api/admin/alerts', {
      signal,
    }),
};
