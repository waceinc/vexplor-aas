/**
 * The collector's OPC UA reader against a secure server (plan gap 2): security mode, policy and a user name, over the
 * real protocol on 127.0.0.1. Before this, the reader connected anonymously without security only — a factory server
 * that offers no `None` endpoint could not be read at all.
 *
 * Certificates go into temporary folders (RSA key generation takes seconds — hence the timeouts).
 */
// Must stay the first import — see fake-home.ts
import { fakeHome, fakeRoot, restoreEnv } from './fake-home.js';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Environment } from '@aas/core';
import { AasOpcUaServer, OpcUaReader, planForPackage, type PublishPlan } from '../src/index.js';

const PID = 'pkg-rs';
const NODE = `ns=1;s=${PID}/https://ktl/sm/tech/MotorSpeed`;
const environment = {
  assetAdministrationShells: [{ modelType: 'AssetAdministrationShell', id: 'aas-r', idShort: 'Machine', assetInformation: { assetKind: 'Instance' } }],
  submodels: [
    {
      modelType: 'Submodel',
      id: 'https://ktl/sm/tech',
      idShort: 'TechnicalData',
      submodelElements: [{ modelType: 'Property', idShort: 'MotorSpeed', valueType: 'xs:double', value: '1200.5' }],
    },
  ],
} as unknown as Environment;

const root = fakeRoot;
const clientPki = join(root, 'reader-pki');
let server: AasOpcUaServer;
let endpoint = '';
const operator = { userName: 'operator', password: 'correct-horse' };

async function startOn(port: number): Promise<void> {
  server = new AasOpcUaServer({
    port,
    hostname: '127.0.0.1',
    load: async (): Promise<PublishPlan[]> => [planForPackage(environment, { packageId: PID, name: 'Machine' })],
    security: {
      mode: 'secure',
      pkiDir: join(root, 'server-pki'),
      verifyUser: async (username, password) => username === operator.userName && password === operator.password,
    },
  });
  await server.start();
  endpoint = `opc.tcp://127.0.0.1:${port}/UA/AAS`;
}

beforeAll(async () => {
  try {
    await startOn(14890);
  } catch {
    await startOn(14891);
  }
}, 120_000);

afterAll(async () => {
  await server?.stop();
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

const secure = { mode: 'SignAndEncrypt', policy: 'Basic256Sha256' } as const;

describe('OPC UA reader — secure server', () => {
  it('cannot read a secure server anonymously without security (the gap this closes)', async () => {
    await expect(OpcUaReader.connect({ endpoint, connectTimeoutMs: 15_000 })).rejects.toThrow();
  }, 60_000);

  it('refuses an outdated policy before connecting, and Sign without a certificate folder', async () => {
    await expect(OpcUaReader.connect({ endpoint, security: { mode: 'Sign', policy: 'Basic128Rsa15' }, pkiDir: clientPki })).rejects.toThrow(/Basic128Rsa15/);
    await expect(OpcUaReader.connect({ endpoint, security: secure })).rejects.toThrow(/pkiDir/);
  });

  it('reads over SignAndEncrypt with a user name once each side trusts the other', async () => {
    // The server does not know the reader's certificate yet — refused, and kept for an administrator
    await expect(OpcUaReader.connect({ endpoint, security: secure, user: operator, pkiDir: clientPki, trustUnknownServer: true, connectTimeoutMs: 15_000 })).rejects.toThrow();
    const rejected = (await server.pki()!.list()).rejected;
    expect(rejected).toHaveLength(1);
    expect(await server.pki()!.trust(rejected[0]!.thumbprint)).toBe(true);

    const reader = await OpcUaReader.connect({ endpoint, security: secure, user: operator, pkiDir: clientPki, trustUnknownServer: true, connectTimeoutMs: 15_000 });
    try {
      const [speed] = await reader.read([NODE]);
      expect(speed!.error).toBeUndefined();
      expect(speed!.value).toBeCloseTo(1200.5);
    } finally {
      await reader.close();
    }
  }, 120_000);

  it('refuses a wrong password', async () => {
    await expect(
      OpcUaReader.connect({ endpoint, security: secure, user: { ...operator, password: 'wrong' }, pkiDir: clientPki, trustUnknownServer: true, connectTimeoutMs: 15_000 }),
    ).rejects.toThrow();
  }, 60_000);

  it('does not accept a server certificate it has never seen unless told to', async () => {
    const fresh = join(root, 'reader-pki-strict');
    await expect(OpcUaReader.connect({ endpoint, security: secure, user: operator, pkiDir: fresh, connectTimeoutMs: 15_000 })).rejects.toThrow();
    // The server's certificate waits in rejected/ for a person to move it to trusted/
    expect(readdirSync(join(fresh, 'rejected')).length).toBeGreaterThan(0);
  }, 120_000);

  it('writes nothing into the default node-opcua folders of the home directory', () => {
    const found = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? found(join(dir, entry.name)) : [join(dir, entry.name)]));
    expect(found(fakeHome)).toEqual([]);
  });
});
