/**
 * Update notices (remote-collector plan R2: "업데이트는 Ed25519 서명 · 기본은 알림만, 고객 승인 뒤 설치").
 *
 * With `update.manifestUrl` and `update.publicKey` in the configuration, the edge fetches a small release manifest once
 * a day and, when it is signed by that key and names a newer version, **reports** it — in the log and in the status of
 * the next batch. It never downloads or installs anything: a person decides, and installs with the installer.
 *
 *     { "schema": "vexplor.edgeRelease/1", "version": "1.2.0", "url": "https://…/vexplor-edge-1.2.0.msi",
 *       "sha256": "…", "notes": "…", "signature": "<Ed25519 over the canonical JSON of the other fields, base64url>" }
 *
 * Important: without the two settings no update request is made at all — the update source is an outbound destination
 *    of its own, listed only when someone configured it (STD-009 T9).
 * Important: a manifest that fails the signature is ignored and logged, never shown as "available" — a proxy or a
 *    hijacked host must not be able to steer someone to install its file.
 */
import { createPublicKey, verify } from 'node:crypto';

import { canonicalJson } from '@aas/core';

export interface ReleaseManifest {
  schema: 'vexplor.edgeRelease/1';
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

export type UpdateCheck = { state: 'current' } | { state: 'available'; release: ReleaseManifest } | { state: 'rejected'; reason: string };

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The bytes a release signature covers: every field but `signature`, canonical JSON */
export function releaseSigningBytes(manifest: Record<string, unknown>): Buffer {
  const { signature: _signature, ...rest } = manifest;
  return Buffer.from(canonicalJson(rest));
}

/** 1.10.0 > 1.9.3; pre-release suffixes are not offered */
export function newer(candidate: string, current: string): boolean {
  const parts = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Checks a fetched manifest against the release key and the running version */
export function checkRelease(raw: unknown, publicKey: string, currentVersion: string): UpdateCheck {
  if (typeof raw !== 'object' || raw === null) return { state: 'rejected', reason: 'not a manifest' };
  const manifest = raw as Record<string, unknown>;
  const fields = ['version', 'url', 'sha256'] as const;
  if (manifest['schema'] !== 'vexplor.edgeRelease/1' || fields.some((field) => typeof manifest[field] !== 'string') || typeof manifest['signature'] !== 'string') {
    return { state: 'rejected', reason: 'not a vexplor.edgeRelease/1 manifest' };
  }
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64url')]), format: 'der', type: 'spki' });
  if (!verify(null, releaseSigningBytes(manifest), key, Buffer.from(manifest['signature'] as string, 'base64url'))) {
    return { state: 'rejected', reason: 'signature does not match the release key' };
  }
  const url = new URL(manifest['url'] as string);
  if (url.protocol !== 'https:') return { state: 'rejected', reason: 'release url is not https' };
  if (!newer(manifest['version'] as string, currentVersion)) return { state: 'current' };
  const { signature: _signature, ...release } = manifest;
  return { state: 'available', release: release as unknown as ReleaseManifest };
}
