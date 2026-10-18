/**
 * "Load from equipment" against a server that offers no None endpoint and wants a user name (2.8.0). Before, browse
 * connected None and anonymous only, so such a factory server could not be browsed at all.
 *
 * Certificates go into temporary folders (RSA key generation takes seconds — hence the timeouts).
 */
// Must stay the first import — see fake-home.ts
import { fakeRoot, restoreEnv } from './fake-home.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataType, MessageSecurityMode, OPCUACertificateManager, OPCUAServer, SecurityPolicy, Variant } from 'node-opcua';
import { browseDevice } from '../src/browse.js';

let server: OPCUAServer;
let endpoint = '';
const operator = { userName: 'operator', password: 'correct-horse' };

async function startOn(port: number): Promise<void> {
  const serverCertificateManager = new OPCUACertificateManager({ rootFolder: join(fakeRoot, 'browse-server-pki'), automaticallyAcceptUnknownCertificate: true });
  await serverCertificateManager.initialize();
  server = new OPCUAServer({
    port,
    hostname: '127.0.0.1',
    resourcePath: '/UA/SecurePlc',
    serverCertificateManager,
    securityModes: [MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
    securityPolicies: [SecurityPolicy.Basic256Sha256],
    allowAnonymous: false,
    userManager: { isValidUser: (userName: string, password: string) => userName === operator.userName && password === operator.password },
    buildInfo: { productName: 'Secure test PLC', buildNumber: '1', buildDate: new Date(0) },
  });
  await server.initialize();
  const namespace = server.engine.addressSpace!.getOwnNamespace();
  const machine = namespace.addObject({ organizedBy: server.engine.addressSpace!.rootFolder.objects, browseName: 'Machine' });
  namespace.addVariable({ componentOf: machine, browseName: 'Pressure', nodeId: 's=Machine.Pressure', dataType: 'Double', value: { get: () => new Variant({ dataType: DataType.Double, value: 3.5 }) } });
  await server.start();
  endpoint = `opc.tcp://127.0.0.1:${port}/UA/SecurePlc`;
}

beforeAll(async () => {
  try {
    await startOn(14892);
  } catch {
    await startOn(14893);
  }
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  restoreEnv();
  rmSync(join(fakeRoot, 'browse-server-pki'), { recursive: true, force: true });
});

describe('browse a secure server', () => {
  it('None and anonymous cannot browse it (the gap this closes)', async () => {
    await expect(browseDevice({ endpoint, connectTimeoutMs: 15_000 })).rejects.toThrow();
  }, 60_000);

  it('Sign with a policy, a user name and the collector certificate store finds the tags', async () => {
    const result = await browseDevice({
      endpoint,
      security: { mode: 'Sign', policy: 'Basic256Sha256' },
      user: operator,
      pkiDir: join(fakeRoot, 'browse-client-pki'),
      trustUnknownServer: true,
      connectTimeoutMs: 15_000,
    });
    expect(result.nodes.map((node) => node.nodeId)).toContain('ns=1;s=Machine.Pressure');
  }, 60_000);
});
