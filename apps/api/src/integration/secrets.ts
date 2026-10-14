/**
 * Sealing of webhook signing secrets and MQTT credentials (docs/design/integration-v1.md §5.6).
 *
 * Why sealed and not plain: the store is backed up, copied, read by DB tools. A signing secret in plain text there lets
 * anyone with a backup forge events that an MES will act on. AES-256-GCM with a master key outside the store means a
 * stolen backup alone is not enough.
 *
 * Format: `<keyId>:<base64(iv 12 | tag 16 | ciphertext)>`; `keyId` = first 8 hex of sha256(key), so a later key
 * rotation can tell which key sealed a value without a migration.
 * Master key, in order: `AAS_SECRET_KEY` (base64, 32 bytes; anything else is a startup error) → folder store:
 * `<data dir>/secret.key` (created 0600 on first need) → memory store: random per process (`ephemeral`) →
 * PostgreSQL without `AAS_SECRET_KEY`: `missing` (creating a subscription answers 503).
 * Important: secrets are never logged and never put in audit details or delivery rows.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fill, tr } from '@aas/core';

export type MasterKeySource = 'env' | 'file' | 'ephemeral' | 'missing';
export type StoreKind = 'memory' | 'folder' | 'postgres';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  readonly keyId: string;

  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(fill(tr('비밀 키는 {0}바이트여야 합니다.'), { 0: KEY_BYTES }));
    this.keyId = createHash('sha256').update(key).digest('hex').slice(0, 8);
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${this.keyId}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  /** Throws when the value was sealed with another key or was altered (GCM tag check) */
  open(sealed: string): string {
    const colon = sealed.indexOf(':');
    const keyId = sealed.slice(0, colon);
    if (colon < 0 || keyId !== this.keyId) {
      throw new Error(fill(tr('다른 비밀 키로 잠근 값입니다 (키 {0}). AAS_SECRET_KEY를 확인하십시오.'), { 0: keyId || '?' }));
    }
    const raw = Buffer.from(sealed.slice(colon + 1), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }
}

export interface MasterKey {
  box: SecretBox | undefined;
  source: MasterKeySource;
  /** Where the key file is, when it came from one — the startup log warns that backups of that folder contain it */
  file?: string;
  /** Set when the key file was readable by others and its mode was changed to 0600 */
  warning?: string;
}

/** Makes the key file 0600 when group / others had access. Returns a warning line when it changed something */
function tightenMode(file: string): string | undefined {
  // Windows has no POSIX modes — the folder's ACL is what protects it there
  if (process.platform === 'win32') return undefined;
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) === 0) return undefined;
  chmodSync(file, 0o600);
  return fill(tr('비밀 키 파일 {0}을(를) 다른 사용자도 읽을 수 있었습니다({1}) — 0600으로 바꿨습니다.'), { 0: file, 1: mode.toString(8) });
}

function keyFromBase64(text: string): Buffer {
  const trimmed = text.trim();
  const key = Buffer.from(trimmed, 'base64');
  // Buffer.from skips characters it does not know — check the alphabet first, or a typo would yield a different key
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || key.length !== KEY_BYTES) {
    throw new Error(tr('AAS_SECRET_KEY는 32바이트를 base64로 적은 값이어야 합니다 (예: openssl rand -base64 32).'));
  }
  return key;
}

/**
 * Picks the master key. Throws on an invalid `AAS_SECRET_KEY` — starting with a key that cannot open yesterday's
 * secrets would turn every delivery into a failure that looks like the receiver's fault.
 */
export function loadMasterKey(options: { env: Record<string, string | undefined>; storeKind: StoreKind; dataDir?: string }): MasterKey {
  const fromEnv = options.env['AAS_SECRET_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { box: new SecretBox(keyFromBase64(fromEnv)), source: 'env' };
  if (options.storeKind === 'folder' && options.dataDir !== undefined) {
    const file = join(options.dataDir, 'secret.key');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      try {
        writeFileSync(file, randomBytes(KEY_BYTES).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
      } catch (error) {
        // Another process (a second server on the same folder) created it first — use the key it wrote
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    // Important: a key file others can read is a key everyone with a shell has. Tighten it, and say so
    const warning = tightenMode(file);
    return { box: new SecretBox(keyFromBase64(readFileSync(file, 'utf8'))), source: 'file', file, ...(warning ? { warning } : {}) };
  }
  // A folder store whose folder is unknown here (embedded use) is treated like memory: the key lives as long as the process
  if (options.storeKind !== 'postgres') return { box: new SecretBox(randomBytes(KEY_BYTES)), source: 'ephemeral' };
  return { box: undefined, source: 'missing' };
}

/** A new signing secret in the Standard Webhooks form: `whsec_` + base64 of 32 random bytes */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(KEY_BYTES).toString('base64')}`;
}

/** Last 4 characters — enough to tell two secrets apart on screen, too little to guess anything */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}
