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
