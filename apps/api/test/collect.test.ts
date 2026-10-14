/**
 * Collection path checks (M8) — with a fake adapter.
 *
 * Real OPC UA round trips are covered by the built-in server tests in packages/opcua.
 * What matters here is **the API contract**: interface exposure, running collection, time-series queries,
 * and the response on deployments without an adapter.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { canonicalJson } from '@aas/core';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

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

/** Builds a package carrying an AID submodel */
async function seeded(options: { withAid?: boolean; reader?: boolean } = {}) {
  const store = new InMemoryStore();
  await store.init();
  const pkg = readAasx(goldenBytes);

  if (options.withAid !== false) {
    pkg.environment.submodels!.push({
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
          smc('EndpointMetadata', [prop('base', 'opc.tcp://192.168.0.10:4840')]),
          smc('InteractionMetadata', [
            smc('properties', [
              smc('MotorSpeed', [
                prop('unit', 'rpm'),
                smc('forms', [prop('href', 'ns=1;s=Speed')]),
              ]),
            ]),
          ]),
        ]),
      ],
    } as never);
  }

  const record = await store.importPackage({ name: '01.aasx', package: pkg });

  const openReader = async (descriptor: AidInterface): Promise<ProtocolReader> => ({
    base: descriptor.base!,
    read: async (sources) =>
      sources.map((source) => ({ source, value: 1234.5, quality: 'Good', observedAt: '2026-08-24T00:00:00.000Z' })),
    close: async () => {},
  });

  const handle = createApi(store, options.reader === false ? {} : { openReader });
  const call = async (
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> => {
    const response = await handle({
      method,
      path,
      query: init.query ?? {},
      headers: {},
      ...(init.body === undefined ? {} : { body: init.body }),
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };

  return { store, packageId: record.id, call };
}

describe('collection path (M8)', () => {
  it('reports the interfaces described by the AID — the source is the AID inside the file', async () => {
    const { packageId, call } = await seeded();
    const result = await call('GET', `/packages/${packageId}/interfaces`);

    expect(result.status).toBe(200);
    expect(result.body.source).toBe('AssetInterfacesDescription');
    expect(result.body.interfaces).toHaveLength(1);
    expect(result.body.interfaces[0]).toMatchObject({
      name: 'InterfaceTemplateForOPCUA',
      protocol: 'OPCUA',
      base: 'opc.tcp://192.168.0.10:4840',
    });
    expect(result.body.interfaces[0].properties[0]).toMatchObject({
      name: 'MotorSpeed',
      unit: 'rpm',
      href: 'ns=1;s=Speed',
    });
  });

  it('collected values go into the time series and the model stays unchanged (option A)', async () => {
    const { store, packageId, call } = await seeded();
    const before = canonicalJson(await store.getEnvironment(packageId));

    const cycle = await call('POST', `/packages/${packageId}/collect`);
    expect(cycle.status).toBe(200);
    expect(cycle.body.collected).toBe(1);
    expect(cycle.body.interfaces[0].report.failures).toEqual([]);

    const values = await call('GET', `/packages/${packageId}/values`);
    expect(values.body.result).toHaveLength(1);
    expect(values.body.result[0]).toMatchObject({
      interfaceName: 'InterfaceTemplateForOPCUA',
      propertyName: 'MotorSpeed',
      source: 'ns=1;s=Speed',
      valueNumber: 1234.5,
      quality: 'Good',
    });

    // Important: collecting is not editing
    expect(canonicalJson(await store.getEnvironment(packageId))).toBe(before);
  });

  it('queries can be narrowed — by name, time range, and count', async () => {
    const { packageId, call } = await seeded();
    await call('POST', `/packages/${packageId}/collect`);

    expect(
      (await call('GET', `/packages/${packageId}/values`, { query: { property: 'MotorSpeed' } })).body
        .result,
    ).toHaveLength(1);
    expect(
      (await call('GET', `/packages/${packageId}/values`, { query: { property: '없는것' } })).body.result,
    ).toHaveLength(0);
    expect(
      (await call('GET', `/packages/${packageId}/values`, { query: { from: '2027-01-01T00:00:00Z' } }))
        .body.result,
    ).toHaveLength(0);

    const bad = await call('GET', `/packages/${packageId}/values`, { query: { limit: '많이' } });
    expect(bad.status).toBe(400);
  });

  it('without an AID, answers that the address to collect is unknown', async () => {
    const { packageId, call } = await seeded({ withAid: false });
    const result = await call('POST', `/packages/${packageId}/collect`);
    expect(result.status).toBe(404);
    expect(result.body.messages[0].text).toContain('AssetInterfacesDescription');
  });

  it('501 on a deployment without a collection adapter — some servers only author', async () => {
    const { packageId, call } = await seeded({ reader: false });
    const result = await call('POST', `/packages/${packageId}/collect`);
    expect(result.status).toBe(501);
    expect(result.body.messages[0].code).toBe('NotImplemented');
  });
});

describe('Important: read-only overlay of collected values (equivalent to BaSyx DataBridge)', () => {
  /**
   * In BaSyx, DataBridge writes values into the Submodel so other systems see current values through the standard API.
   * We use option A (the file is the source), so values only go into the time series —
   * only when `live=true` are they overlaid **on the response** to give the same appearance. The file stays unchanged.
   */
  const seedValue = async (store: Awaited<ReturnType<typeof seeded>>['store'], packageId: string) => {
    await store.appendValues(packageId, [
      {
        packageId,
        interfaceName: 'InterfaceTemplateForOPCUA',
        propertyName: 'SerialNumber',
        observedAt: '2026-08-25T00:00:00.000Z',
        valueText: '현장에서-읽은-값',
        quality: 'Good',
      },
    ]);
  };

  const nameplateId =
    'https://www.smart-factory.kr/ids/sm/RollFormingMachine/DigitalNameplate/3/1';
  const encoded = Buffer.from(nameplateId).toString('base64url');

  it('file values by default — they must not be mixed in without any indication', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    const result = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber`,
    );
    expect(result.status).toBe(200);
    expect(result.body.value).toBe('EXM-RFL-2026-00127');
  });

  it('with live=true the field values are visible', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    const result = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber`,
      { query: { live: 'true' } },
    );
    expect(result.body.value).toBe('현장에서-읽은-값');
  });

  it('also overlaid on $value — that is where external systems actually read', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    const result = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber/$value`,
      { query: { live: 'true' } },
    );
    expect(JSON.stringify(result.body)).toContain('현장에서-읽은-값');
  });

  it('Important: the file stays unchanged — overlaying does not change stored content', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);
    const before = canonicalJson(await store.getEnvironment(packageId));

    await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      query: { live: 'true' },
    });

    expect(canonicalJson(await store.getEnvironment(packageId))).toBe(before);
  });

  it('Important: overlaid values are not saved — edits are always based on file values', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    // After reading with live, editing another element must leave SerialNumber at the file value
    await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      query: { live: 'true' },
    });
    await call(
      'PATCH',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/YearOfConstruction/$value`,
      { body: '2027' },
    );

    const after = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber`,
    );
    expect(after.body.value).toBe('EXM-RFL-2026-00127');
  });
});
