/**
 * Adapter registry.
 *
 * Adapters register themselves at import time and the poller looks them up by
 * the `adapter` column on a device row. Nothing outside this file needs to know
 * which adapters exist, which is what keeps adding one a self-contained change.
 */
import { DeviceError, type DeviceAdapter } from './adapter.js';

const adapters = new Map<string, DeviceAdapter<never>>();

export function registerAdapter<TConfig>(adapter: DeviceAdapter<TConfig>): void {
  if (adapters.has(adapter.id)) {
    // A duplicate id means two adapters would silently shadow each other
    // depending on import order, which is the kind of bug that only shows up
    // on someone else's machine.
    throw new Error(`Adapter "${adapter.id}" is already registered.`);
  }
  adapters.set(adapter.id, adapter as unknown as DeviceAdapter<never>);
}

/** Throws rather than returning undefined: an unknown adapter id is a real
 * configuration error, and the device row naming it cannot be polled. */
export function getAdapter(id: string): DeviceAdapter<never> {
  const adapter = adapters.get(id);
  if (adapter === undefined) {
    throw new DeviceError(
      `No adapter registered for "${id}". Known adapters: ${[...adapters.keys()].join(', ') || 'none'}.`,
      'CONFIG',
    );
  }
  return adapter;
}

export function hasAdapter(id: string): boolean {
  return adapters.has(id);
}

export function listAdapters(): DeviceAdapter<never>[] {
  return [...adapters.values()];
}

/** Test-only: the registry is process-wide, so tests must be able to reset it. */
export function clearAdapters(): void {
  adapters.clear();
}
