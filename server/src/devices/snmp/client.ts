/**
 * Thin promise wrapper around `net-snmp`.
 *
 * Kept deliberately small and separate from the normaliser so the parsing logic
 * can be tested against captured walks without a network. This file is the only
 * place that knows net-snmp exists.
 *
 * `net-snmp` is pure JavaScript, which matters: it keeps `npm ci
 * --ignore-scripts` working in the container build and avoids adding a compiler
 * to the image.
 */
import {
  AuthProtocols,
  createSession,
  createV3Session,
  isVarbindError,
  PrivProtocols,
  SecurityLevel,
  Version1,
  Version2c,
  type Session,
  type Varbind,
} from 'net-snmp';

import { DeviceError } from '../adapter.js';
import type { SnmpValue, SnmpWalk } from './normalize.js';

export type SnmpVersion = '1' | '2c' | '3';
export type AuthProtocol = 'none' | 'md5' | 'sha';
export type PrivProtocol = 'none' | 'des' | 'aes';

export interface SnmpConnection {
  host: string;
  port: number;
  version: SnmpVersion;
  community: string;
  username: string;
  authProtocol: AuthProtocol;
  authKey: string;
  privProtocol: PrivProtocol;
  privKey: string;
  timeoutMs: number;
  retries: number;
}

export interface SnmpClient {
  /** Walks a subtree, returning fully-qualified OIDs mapped to values. */
  walk(baseOid: string): Promise<SnmpWalk>;
  get(oids: string[]): Promise<SnmpWalk>;
  close(): void;
}

/** net-snmp yields Buffers for OCTET STRINGs; everything else is number-ish. */
function toValue(value: Varbind['value']): SnmpValue {
  // Bit-field columns must stay binary; text columns are decoded by the
  // normaliser, which knows which is which.
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return null;
  return String(value);
}

const AUTH: Record<AuthProtocol, AuthProtocols> = {
  none: AuthProtocols.none,
  md5: AuthProtocols.md5,
  sha: AuthProtocols.sha,
};

const PRIV: Record<PrivProtocol, PrivProtocols> = {
  none: PrivProtocols.none,
  des: PrivProtocols.des,
  aes: PrivProtocols.aes,
};

function openSession(connection: SnmpConnection): Session {
  const shared = {
    port: connection.port,
    timeout: connection.timeoutMs,
    retries: connection.retries,
  };

  if (connection.version !== '3') {
    return createSession(connection.host, connection.community, {
      ...shared,
      version: connection.version === '1' ? Version1 : Version2c,
    });
  }

  // Security level is derived rather than configured: an operator who supplies
  // an auth key means to authenticate, and asking them to also pick a level is
  // one more way to get a silently unauthenticated session.
  const level =
    connection.authProtocol === 'none'
      ? SecurityLevel.noAuthNoPriv
      : connection.privProtocol === 'none'
        ? SecurityLevel.authNoPriv
        : SecurityLevel.authPriv;

  return createV3Session(
    connection.host,
    {
      name: connection.username,
      level,
      authProtocol: AUTH[connection.authProtocol],
      authKey: connection.authKey,
      privProtocol: PRIV[connection.privProtocol],
      privKey: connection.privKey,
    },
    shared,
  );
}

function toDeviceError(error: unknown, host: string): DeviceError {
  if (error instanceof DeviceError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof Error && error.name === 'RequestTimedOutError') {
    return new DeviceError(
      `SNMP request to ${host} timed out. The device may be asleep, may not have SNMP enabled, or the community string may be wrong.`,
      'TIMEOUT',
      { cause: error },
    );
  }
  if (/authentication|authorization|usmStats|unknown user|wrong digest|not in time window/i.test(message)) {
    return new DeviceError(`SNMP authentication failed for ${host}: ${message}`, 'AUTH', {
      cause: error,
    });
  }
  if (/EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return new DeviceError(`SNMP host ${host} is unreachable: ${message}`, 'UNREACHABLE', {
      cause: error,
    });
  }

  return new DeviceError(`SNMP request to ${host} failed: ${message}`, 'BAD_RESPONSE', {
    cause: error,
  });
}

export function createClient(connection: SnmpConnection): SnmpClient {
  const session = openSession(connection);
  let closed = false;

  return {
    walk(baseOid) {
      return new Promise<SnmpWalk>((resolve, reject) => {
        const result: SnmpWalk = {};

        const feed = (varbinds: Varbind[]): void => {
          for (const varbind of varbinds) {
            // A device that does not implement part of a table answers with
            // noSuchInstance rather than omitting the row; recording those
            // would create phantom supplies.
            if (isVarbindError(varbind)) continue;
            result[varbind.oid] = toValue(varbind.value);
          }
        };

        const done = (error: Error | null): void => {
          if (error !== null) {
            // Some agents report an empty subtree as an error. That is a
            // legitimate answer — the device has no such table — so it resolves
            // empty rather than failing the whole read.
            if (/no such|end of mib/i.test(error.message)) {
              resolve(result);
              return;
            }
            reject(toDeviceError(error, connection.host));
            return;
          }
          resolve(result);
        };

        try {
          // GETBULK where the protocol allows it; net-snmp falls back to
          // GETNEXT on v1 by itself.
          session.subtree(baseOid, 20, feed, done);
        } catch (error) {
          reject(toDeviceError(error, connection.host));
        }
      });
    },

    get(oids) {
      return new Promise<SnmpWalk>((resolve, reject) => {
        if (oids.length === 0) {
          resolve({});
          return;
        }

        session.get(oids, (error, varbinds) => {
          if (error !== null) {
            reject(toDeviceError(error, connection.host));
            return;
          }

          const result: SnmpWalk = {};
          for (const varbind of varbinds ?? []) {
            if (isVarbindError(varbind)) continue;
            result[varbind.oid] = toValue(varbind.value);
          }
          resolve(result);
        });
      });
    },

    close() {
      if (closed) return;
      closed = true;
      session.close();
    },
  };
}
