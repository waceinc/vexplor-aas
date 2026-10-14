/**
 * M8 end to end — AID -> OPC UA -> collection -> time series.
 *
 * Threads one line through the **real protocol** without a physical PLC. Pieces that pass individually often
 * misalign once joined, so this test is the actual acceptance criterion for M8.
 *
 * Also checked: Important: **collecting leaves the model unchanged** (value sync option A).
 */
import { readAasx } from '@aas/aasx';
import { canonicalJson, type Environment } from '@aas/core';
import { collectOnce, parseAid } from '@aas/collector';
import { OpcUaReader } from '@aas/opcua';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './server.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

let server: TestServer;

beforeAll(async () => {
  try {
    server = await startTestServer(14850);
  } catch {
    server = await startTestServer(14851);
  }
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

/** Adds an AID submodel to the golden file — how a real device file describes its interface */
function withAid(environment: Environment, endpoint: string): Environment {
  const smc = (idShort: string, value: unknown[]): unknown => ({
    modelType: 'SubmodelElementCollection',
    idShort,
    value,
  });
  const prop = (idShort: string, value: string): unknown => ({
    modelType: 'Property',
    idShort,
    valueType: 'xs:string',
    value,
  });

  const aid = {
    modelType: 'Submodel',
    id: 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/AssetInterfacesDescription/1/0',
    idShort: 'AssetInterfacesDescription',
    kind: 'Template',
    administration: { version: '1', revision: '0' },
    semanticId: {
      type: 'ExternalReference',
      keys: [
        {
          type: 'GlobalReference',
          value: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/1/Submodel',
        },
      ],
    },
    submodelElements: [
      smc('InterfaceTemplateForOPCUA', [
        prop('title', '롤포밍기 제어반'),
        smc('EndpointMetadata', [prop('base', endpoint)]),
        smc('InteractionMetadata', [
          smc('properties', [
            smc('MotorSpeed', [
              prop('key', 'D100'),
              prop('type', 'float'),
              prop('unit', 'rpm'),
              prop('observable', 'true'),
              smc('forms', [prop('href', 'ns=1;s=Machine.MotorSpeed')]),
            ]),
            smc('AlarmActive', [
              prop('type', 'boolean'),
              smc('forms', [prop('href', 'ns=1;s=Machine.AlarmActive')]),
            ]),
            smc('BrokenSensor', [
              prop('type', 'float'),
              smc('forms', [prop('href', 'ns=1;s=Machine.BrokenSensor')]),
            ]),
            // Important: a tag with no value yet — whether it is told apart from a failure (BrokenSensor) is the crux of this test
            smc('NotYetReady', [
              prop('type', 'float'),
              smc('forms', [prop('href', 'ns=1;s=Machine.NotYetReady')]),
            ]),
          ]),
        ]),
      ]),
    ],
  };

  return {
    ...environment,
    submodels: [...(environment.submodels ?? []), aid as never],
  };
}

describe('M8 end to end (AID -> OPC UA -> time series)', () => {
  it('actually reads the addresses the AID names and stores them in the time series', async () => {
    const pkg = readAasx(new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx')));
    const environment = withAid(pkg.environment, server.endpoint);

    const store = new InMemoryStore();
    await store.init();
    const record = await store.importPackage({
      name: '01-롤포밍기.aasx',
      package: { ...pkg, environment },
    });

    // (1) Read the AID inside the file — there is no separate mapping table
    const interfaces = parseAid(await store.getEnvironment(record.id));
    expect(interfaces).toHaveLength(1);
    const descriptor = interfaces[0]!;
    expect(descriptor.protocol).toBe('OPCUA');
    expect(descriptor.base).toBe(server.endpoint);

    // (2) Connect to that address and actually read
    server.setSpeed(1310.75);
    const reader = await OpcUaReader.connect({ endpoint: descriptor.base!, connectTimeoutMs: 5000 });
    const before = canonicalJson(await store.getEnvironment(record.id));

    const report = await collectOnce(
      descriptor,
      reader,
      { append: (samples) => store.appendValues(record.id, samples) },
      { packageId: record.id },
    );
    await reader.close();

    // (3) Healthy tags are stored; bad tags remain with a reason
    expect(report.collected).toBe(2);
    expect(report.failures).toEqual([
      expect.objectContaining({ propertyName: 'BrokenSensor', reason: expect.stringContaining('Bad') }),
    ]);

    // (3-2) Important: a tag with no value yet is **not a failure** — counted separately.
    //     Counting it as a "bad tag" while the machine is fine makes novice users read it as a breakdown
    expect(report.pending).toEqual([
      expect.objectContaining({ propertyName: 'NotYetReady', reason: 'BadWaitingForInitialData' }),
    ]);
    // Important: and nothing goes into the time series — disguising a missing value as an empty sample
    //    leaves a fake history saying "observed at that time"
    expect(await store.readValues(record.id, { propertyName: 'NotYetReady' })).toEqual([]);

    const speed = await store.readValues(record.id, { propertyName: 'MotorSpeed' });
    expect(speed).toHaveLength(1);
    expect(speed[0]!.valueNumber).toBe(1310.75);
    expect(speed[0]!.source).toBe('ns=1;s=Machine.MotorSpeed');
    expect(speed[0]!.quality).toBe('Good');
    // The timestamp is the one the device supplied
    expect(new Date(speed[0]!.observedAt).getTime()).toBeGreaterThan(0);

    const alarm = await store.readValues(record.id, { propertyName: 'AlarmActive' });
    expect(alarm[0]!.valueNumber).toBe(0);
    expect(alarm[0]!.valueText).toBe('false');

    // (4) Important: option A — collecting leaves the model unchanged
    expect(canonicalJson(await store.getEnvironment(record.id))).toBe(before);
    const shell = (await store.getEnvironment(record.id)).assetAdministrationShells![0]!;
    expect(shell.assetInformation.assetKind).toBe('Type'); // still a Type/Template
  }, 60_000);
});
