/**
 * Signed update notices: reported only for a newer release signed by the configured key, never downloaded or installed.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PRODUCT_VERSION } from '@aas/core';
import { describe, expect, it } from 'vitest';
import { EdgeAgent, checkRelease, newer, parseEdgeConfig, releaseSigningBytes } from '../src/index.js';

function releaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url') };
}

function signed(fields: Record<string, unknown>, key: ReturnType<typeof releaseKey>['privateKey']) {
  const manifest = { schema: 'vexplor.edgeRelease/1', url: 'https://downloads.example.com/vexplor-edge-99.0.0.msi', sha256: 'ab'.repeat(32), ...fields };
  return { ...manifest, signature: sign(null, releaseSigningBytes(manifest), key).toString('base64url') };
}

describe('release manifest', () => {
  const key = releaseKey();
  it('reports a newer release signed by the release key', () => {
    expect(checkRelease(signed({ version: '99.0.0' }, key.privateKey), key.publicKey, PRODUCT_VERSION)).toMatchObject({ state: 'available', release: { version: '99.0.0' } });
    expect(checkRelease(signed({ version: '0.0.1' }, key.privateKey), key.publicKey, PRODUCT_VERSION)).toEqual({ state: 'current' });
  });

  it('refuses a tampered manifest, another key and a plain-http file', () => {
    const tampered = { ...signed({ version: '99.0.0' }, key.privateKey), url: 'https://evil.example.com/x.msi' };
    expect(checkRelease(tampered, key.publicKey, PRODUCT_VERSION).state).toBe('rejected');
    expect(checkRelease(signed({ version: '99.0.0' }, releaseKey().privateKey), key.publicKey, PRODUCT_VERSION).state).toBe('rejected');
    expect(checkRelease(signed({ version: '99.0.0', url: 'http://downloads.example.com/x.msi' }, key.privateKey), key.publicKey, PRODUCT_VERSION).state).toBe('rejected');
  });

  it('compares versions numerically', () => {
    expect(newer('1.10.0', '1.9.3')).toBe(true);
    expect(newer('1.9.3', '1.10.0')).toBe(false);
    expect(newer('2.0.0-beta', '1.0.0')).toBe(false);
  });

  it('the agent fetches only the manifest, reports the release and downloads nothing', async () => {
    const config = parseEdgeConfig(
      JSON.stringify({ server: 'http://127.0.0.1:9', stateDir: mkdtempSync(join(tmpdir(), 'edge-update-')), update: { manifestUrl: 'https://downloads.example.com/latest.json', publicKey: key.publicKey } }),
      join(tmpdir(), 'edge.json'),
    );
    const lines: string[] = [];
    const agent = new EdgeAgent({ config, credentials: new Map(), log: (line) => lines.push(line) });
    const fetched: string[] = [];
    agent.http.getJson = async (address: string) => {
      fetched.push(address);
      return { status: 200, headers: {}, body: signed({ version: '99.0.0' }, key.privateKey) };
    };
    await agent.checkUpdate();
    expect(fetched).toEqual(['https://downloads.example.com/latest.json']);
    expect(agent.updateAvailable?.version).toBe('99.0.0');
    expect(agent.status()).toMatchObject({ updateAvailable: '99.0.0' });
    expect(lines.join('\n')).toMatch(/does not install it/);
  });

  it('makes no update request without the settings, and refuses half of them', () => {
    expect(() => parseEdgeConfig(JSON.stringify({ server: 'https://a.example.com', stateDir: '/tmp/x', update: { manifestUrl: 'https://a/latest.json' } }), '/tmp/edge.json')).toThrow(/both/);
    expect(parseEdgeConfig(JSON.stringify({ server: 'https://a.example.com', stateDir: '/tmp/x' }), '/tmp/edge.json').update).toBeUndefined();
  });
});
