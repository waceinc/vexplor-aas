/**
 * OPC UA server security (docs/design/integration-v1.md §7, D16) — secure by default.
 *
 * Over the real protocol on 127.0.0.1: no `None` endpoint, anonymous refused, wrong password refused, an unknown client
 * certificate refused until an administrator trusts it, then a read over Basic256Sha256 / SignAndEncrypt, writes still
 * refused. Certificates are generated into temporary folders (RSA key generation takes seconds — hence the timeouts).
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttributeIds,
  DataType,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAClient,
  SecurityPolicy,
  StatusCodes,
  UserTokenType,
  Variant,
  type ClientSession,
  type UserIdentityInfo,
} from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Environment } from '@aas/core';
import { AasOpcUaServer, planForPackage, type PublishPlan } from '../src/index.js';

const PID = 'pkg-sec';
const NODE = `ns=1;s=${PID}/https://ktl/sm/tech/MotorSpeed`;

const environment = {
  assetAdministrationShells: [{ modelType: 'AssetAdministrationShell', id: 'aas-s', idShort: 'Machine', assetInformation: { assetKind: 'Instance' } }],
  submodels: [
    {
      modelType: 'Submodel',
      id: 'https://ktl/sm/tech',
      idShort: 'TechnicalData',
      submodelElements: [{ modelType: 'Property', idShort: 'MotorSpeed', valueType: 'xs:double', value: '1200.5' }],
    },
  ],
} as unknown as Environment;

const root = mkdtempSync(join(tmpdir(), 'aas-opcua-sec-'));
const serverPki = join(root, 'server-pki');
let server: AasOpcUaServer;
let endpoint = '';
let clientManager: OPCUACertificateManager;
const checked: string[] = [];
const clients: { address?: string; certificateThumbprint?: string }[] = [];

async function startOn(port: number): Promise<void> {
  server = new AasOpcUaServer({
    port,
    hostname: '127.0.0.1',
    load: async (): Promise<PublishPlan[]> => [planForPackage(environment, { packageId: PID, name: 'Machine' })],
    security: {
      mode: 'secure',
      pkiDir: serverPki,
      verifyUser: async (username, password, client) => {
        checked.push(username);
        clients.push(client);
        return username === 'operator' && password === 'correct-horse';
      },
    },
  });
  await server.start();
  endpoint = `opc.tcp://127.0.0.1:${port}/UA/AAS`;
}

function secureClient(): OPCUAClient {
  return OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.SignAndEncrypt,
    securityPolicy: SecurityPolicy.Basic256Sha256,
    clientCertificateManager: clientManager,
    connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 200 },
  });
}

/** Connects and opens a session; the client is always disconnected afterwards */
async function withSession<T>(identity: UserIdentityInfo | undefined, use: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = secureClient();
  try {
    await client.connect(endpoint);
    const session = await client.createSession(identity);
    try {
      return await use(session);
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

beforeAll(async () => {
  clientManager = new OPCUACertificateManager({ rootFolder: join(root, 'client-pki'), automaticallyAcceptUnknownCertificate: true });
  await clientManager.initialize();
  try {
    await startOn(14880);
  } catch {
    await startOn(14881);
  }
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await clientManager?.dispose().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('OPC UA server — secure mode', () => {
  it('reports secure mode, creates the PKI folder 0700, and offers no None endpoint', async () => {
    expect(server.currentStatus()).toMatchObject({ running: true, security: 'secure', pki: serverPki });
    if (process.platform !== 'win32') expect(statSync(serverPki).mode & 0o777).toBe(0o700);

    const discovery = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 0 } });
    await discovery.connect(endpoint);
    const endpoints = await discovery.getEndpoints();
    await discovery.disconnect();
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.map((e) => e.securityPolicyUri)).not.toContain(SecurityPolicy.None);
    expect(endpoints.map((e) => e.securityMode)).not.toContain(MessageSecurityMode.None);
    // No endpoint offers an anonymous token
    const tokens = endpoints.flatMap((e) => (e.userIdentityTokens ?? []).map((t) => t.tokenType));
    expect(tokens).not.toContain(UserTokenType.Anonymous);
    expect(tokens).toContain(UserTokenType.UserName);
  }, 60_000);

  it('refuses an unknown client certificate until it is trusted through the trust store', async () => {
    await expect(withSession({ type: UserTokenType.UserName, userName: 'operator', password: 'correct-horse' }, async () => 'connected')).rejects.toThrow();

    const pki = server.pki();
    expect(pki).toBeDefined();
    const before = await pki!.list();
    expect(before.rejected.length).toBe(1);
    expect(before.trusted).toEqual([]);
    const [rejected] = before.rejected;
    expect(rejected!.thumbprint).toMatch(/^[0-9a-f]{40}$/);
    expect(rejected!.notAfter).toBeDefined();

    expect(await pki!.trust('0'.repeat(40))).toBe(false);
    // Thumbprints are accepted in the colon-separated upper-case form tools display, too
    const display = rejected!.thumbprint.toUpperCase().match(/../g)!.join(':');
    expect(await pki!.trust(display)).toBe(true);
    const after = await pki!.list();
    expect(after.trusted.map((c) => c.thumbprint)).toEqual([rejected!.thumbprint]);
    expect(after.rejected).toEqual([]);
  }, 120_000);

  it('refuses an anonymous session and a wrong password', async () => {
    await expect(withSession(undefined, async () => 'opened')).rejects.toThrow();
    await expect(withSession({ type: UserTokenType.UserName, userName: 'operator', password: 'wrong' }, async () => 'opened')).rejects.toThrow();
    expect(checked).toContain('operator');
    // The check learns which client asked — the throttle counts per client certificate, not per server
    const trusted = (await server.pki()!.list()).trusted[0]!.thumbprint;
    expect(clients.at(-1)).toMatchObject({ certificateThumbprint: trusted, address: expect.stringMatching(/127\.0\.0\.1/) });
  }, 60_000);

  it('reads over Basic256Sha256 / SignAndEncrypt with the right password, and writes stay refused', async () => {
    await withSession({ type: UserTokenType.UserName, userName: 'operator', password: 'correct-horse' }, async (session) => {
      const read = await session.read({ nodeId: NODE, attributeId: AttributeIds.Value });
      expect(read.statusCode).toBe(StatusCodes.Good);
      expect(read.value.value).toBeCloseTo(1200.5);
      const status = await session.write({
        nodeId: NODE,
        attributeId: AttributeIds.Value,
        value: { value: new Variant({ dataType: DataType.Double, value: 1 }) },
      });
      expect(status).not.toBe(StatusCodes.Good);
    });
  }, 60_000);
});

describe('OPC UA server — option checks', () => {
  it('secure mode without a user check refuses to start', async () => {
    const broken = new AasOpcUaServer({ port: 14889, load: async () => [], security: { mode: 'secure', pkiDir: join(root, 'unused') } });
    await expect(broken.start()).rejects.toThrow();
    await broken.stop();
  });

  it('fail-closed: no security option means secure, and without a user check the server refuses to start', async () => {
    const forgotten = new AasOpcUaServer({ port: 14890, load: async () => [] });
    expect(forgotten.currentStatus().security).toBe('secure');
    await expect(forgotten.start()).rejects.toThrow();
    await forgotten.stop();
  });

  it('insecure mode has no trust store and says so in its status', () => {
    const open = new AasOpcUaServer({ load: async () => [], security: { mode: 'insecure' } });
    expect(open.currentStatus().security).toBe('insecure');
    expect(open.pki()).toBeUndefined();
  });
});
