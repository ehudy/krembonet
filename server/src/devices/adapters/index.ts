/**
 * Registers the built-in adapters.
 *
 * Importing this module for its side effect is what populates the registry;
 * `index.ts` does that once at boot, before the poller starts. Keeping the
 * registration here rather than in each adapter file means importing an adapter
 * for a type or a test never mutates global state.
 */
import { registerAdapter } from '../registry.js';
import { ippPrinterAdapter } from './ipp-printer.js';
import { snmpPrinterAdapter } from './snmp-printer.js';

let registered = false;

export function registerBuiltinAdapters(): void {
  // Idempotent: tests reset the registry and re-register, and a double
  // registration is a hard error by design.
  if (registered) return;

  registerAdapter(ippPrinterAdapter);
  registerAdapter(snmpPrinterAdapter);
  registered = true;
}

/** Test-only, paired with `clearAdapters`. */
export function resetBuiltinAdapters(): void {
  registered = false;
}

export { ippPrinterAdapter, snmpPrinterAdapter };
