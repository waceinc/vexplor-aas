/**
 * OPC UA security settings from the environment (design §7, D16).
 *
 * Important: docker-compose passes an **empty string** for every variable that is not set (`${OPCUA_PKI_DIR:-}`).
 *    So '' means "not set" here: `OPCUA_ALLOW_INSECURE=''` is secure, `OPCUA_PKI_DIR=''` falls back to the default.
 */
import { join } from 'node:path';

export type OpcUaMode = 'secure' | 'insecure';

/** Secure unless `OPCUA_ALLOW_INSECURE=on` */
export function opcuaModeFromEnv(env: Record<string, string | undefined>): OpcUaMode {
  return env['OPCUA_ALLOW_INSECURE']?.trim() === 'on' ? 'insecure' : 'secure';
}

/** `OPCUA_PKI_DIR`, else `<AAS_DATA_DIR>/opcua-pki`, else `./opcua-pki` */
export function opcuaPkiDirFromEnv(env: Record<string, string | undefined>): string {
  const explicit = env['OPCUA_PKI_DIR']?.trim();
  if (explicit) return explicit;
  const dataDir = env['AAS_DATA_DIR']?.trim();
  return dataDir ? join(dataDir, 'opcua-pki') : 'opcua-pki';
}

/** The collector's OPC UA certificate store: `OPCUA_CLIENT_PKI_DIR`, else `<AAS_DATA_DIR>/opcua-client-pki`, else `./opcua-client-pki` */
export function opcuaClientPkiDirFromEnv(env: Record<string, string | undefined>): string {
  const explicit = env['OPCUA_CLIENT_PKI_DIR']?.trim();
  if (explicit) return explicit;
  const dataDir = env['AAS_DATA_DIR']?.trim();
  return dataDir ? join(dataDir, 'opcua-client-pki') : 'opcua-client-pki';
}

/**
 * Whether the collector accepts an OPC UA server certificate it has never seen (`OPCUA_CLIENT_TRUST=first-use`).
 * Default no: the certificate waits in `<client pki>/rejected` until a person moves it to `trusted/certs`.
 */
export function opcuaClientTrustsFirstUse(env: Record<string, string | undefined>): boolean {
  return env['OPCUA_CLIENT_TRUST']?.trim() === 'first-use';
}

export interface OpcUaCredential {
  userName: string;
  password: string;
}

/**
 * User names and passwords for OPC UA servers, by endpoint, from the JSON file `OPCUA_CLIENT_CREDENTIALS` names:
 * `{ "opc.tcp://10.0.0.5:4840": { "userName": "…", "password": "…" } }`.
 * Important: passwords never live in the AAS — AID only says that a server wants a user name
 *    (`uav_userIdentityToken`). An entry that is not a pair of strings is an error, not silently skipped.
 */
export function parseOpcUaCredentials(text: string): Map<string, OpcUaCredential> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('OPCUA_CLIENT_CREDENTIALS: expected an object of endpoints');
  const out = new Map<string, OpcUaCredential>();
  for (const [endpoint, value] of Object.entries(parsed)) {
    const entry = value as { userName?: unknown; password?: unknown } | null;
    if (typeof entry?.userName !== 'string' || typeof entry.password !== 'string') {
      throw new Error(`OPCUA_CLIENT_CREDENTIALS: ${endpoint} needs a userName and a password (strings)`);
    }
    out.set(endpoint, { userName: entry.userName, password: entry.password });
  }
  return out;
}
