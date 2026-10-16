/**
 * The edge's identity: an Ed25519 key pair made on this machine, and the device id the server gave at registration.
 *
 * Important: the private key never leaves this machine — only the public key is sent, once, at registration. The file is
 *    written with mode 0600 (owner only) where the platform honours it; on Windows the installer places stateDir in a
 *    folder only the service account can read (R3).
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Identity {
  publicKey: string;
  privateKeyPem: string;
  deviceId?: string;
  registeredAt?: string;
  limits?: { maxBatchBytes: number; maxSamplesPerBatch: number; requestsPerMinute: number };
}

const FILE = 'identity.json';

export function identityPath(stateDir: string): string {
  return join(stateDir, FILE);
}

/** The stored identity, or a new key pair (not yet registered) */
export function loadOrCreateIdentity(stateDir: string): Identity {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = identityPath(stateDir);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Identity;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const identity: Identity = {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
  saveIdentity(stateDir, identity);
  return identity;
}

export function saveIdentity(stateDir: string, identity: Identity): void {
  const file = identityPath(stateDir);
  writeFileSync(`${file}.tmp`, JSON.stringify(identity, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
