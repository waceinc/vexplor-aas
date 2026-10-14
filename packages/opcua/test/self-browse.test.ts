/**
 * Important: **blocking self-browse** — guards against an incident that actually happened.
 *
 * A user entered our own tool's OPC UA address as the "device address" and browsed it, and the 79 AAS items we serve
 * (nameplate info such as manufacturer name and serial number) came back as "tags to collect".
 * The screen invited that path — the export address was shown right next to the collection controls.
 *
 * Important: this is a **block**, not a warning. Adding them creates dozens of entries and CDs in the model,
 *    while "Delete link" removes only the AID — there is no way back.
 * Important: comparing address strings cannot catch it. Different hostnames/IPs can be the same server.
 *    So we **ask the other side** (applicationUri · productUri).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AasOpcUaServer, browseDevice, planForPackage, SelfBrowseError } from '../src/index.js';
import type { Environment } from '@aas/core';
import { startTestServer, type TestServer } from './server.js';

const environment = {
  assetAdministrationShells: [
    { modelType: 'AssetAdministrationShell', id: 'aas-1', idShort: '롤포밍기', assetInformation: { assetKind: 'Type' } },
  ],
  submodels: [
    {
      modelType: 'Submodel',
      id: 'https://ktl/sm/dn',
      idShort: 'DigitalNameplate',
      submodelElements: [
        { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: '알에프엠기계(주)' },
      ],
    },
  ],
} as unknown as Environment;

let ours: AasOpcUaServer;
let ourEndpoint: string;
let device: TestServer;

async function startOurs(port: number): Promise<void> {
  ours = new AasOpcUaServer({
    port,
    hostname: '127.0.0.1',
    load: async () => [planForPackage(environment, { packageId: 'pkg-1' })],
    // The browse test connects without credentials — the unauthenticated mode must be asked for explicitly
    security: { mode: 'insecure' },
  });
  await ours.start();
  ourEndpoint = `opc.tcp://127.0.0.1:${port}/UA/AAS`;
}

beforeAll(async () => {
  try {
    await startOurs(14890);
  } catch {
    await startOurs(14891);
  }
  try {
    device = await startTestServer(14892);
  } catch {
    device = await startTestServer(14893);
  }
}, 60_000);

afterAll(async () => {
  await ours?.stop();
  await device?.stop();
});

describe('self-browse', () => {
  it('Important: blocks browsing our own server — the incident where nameplate info came back as "tags to collect"', async () => {
    const selfUri = ours.currentStatus().instanceUri!;
    expect(selfUri).toBeTruthy();

    await expect(browseDevice({ endpoint: ourEndpoint, selfUri })).rejects.toThrow(SelfBrowseError);
    await expect(browseDevice({ endpoint: ourEndpoint, selfUri })).rejects.toThrow(
      /이 저작도구가 값을 내주는/,
    );
  }, 30_000);

  it('distinguishes why it was blocked — this very instance, or the same tool on another machine', async () => {
    const selfUri = ours.currentStatus().instanceUri!;
    const mine = await browseDevice({ endpoint: ourEndpoint, selfUri }).catch((e: unknown) => e);
    expect((mine as SelfBrowseError).kind).toBe('self');

    // Without selfUri (= seen from another process), productUri reveals it is the same tool
    const other = await browseDevice({ endpoint: ourEndpoint }).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(SelfBrowseError);
    expect((other as SelfBrowseError).kind).toBe('sibling');
    expect((other as SelfBrowseError).message).toContain('다른 컴퓨터');
  }, 30_000);

  it('Important: still browses real devices — the block must not stop normal operation', async () => {
    const selfUri = ours.currentStatus().instanceUri!;
    const result = await browseDevice({ endpoint: device.endpoint, selfUri });
    expect(result.nodes.map((node) => node.name)).toContain('MotorSpeed');
  }, 30_000);
});
