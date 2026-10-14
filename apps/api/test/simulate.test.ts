/**
 * "Connect to virtual PLC" — how an evaluator who only has the installer reproduces the bundle.
 *
 * Important: the point of this test: **does a single button press get all the way to real OPC UA collection?** Not a mock —
 *    it actually connects to the built-in virtual PLC (a node-opcua server) and reads values.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import type { AidInterface } from '@aas/collector';
import { OpcUaReader, SIMULATOR_TITLE, SimulatorServer } from '@aas/opcua';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const golden = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')));
const PORT = 14870 + Math.floor(Math.random() * 100);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('connecting to the virtual PLC', () => {
  const simulator = new SimulatorServer({ port: PORT });
  const store = new InMemoryStore();
  const handle = createApi(store, {
    openReader: async (descriptor: AidInterface) => OpcUaReader.connect({ endpoint: descriptor.base! }),
    simulate: async (environment) => ({ ...(await simulator.attach(environment as never)), title: SIMULATOR_TITLE }),
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await handle({
      method,
      path,
      query: {},
      queryAll: {},
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body } : {}),
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };
  let machineId: string;

  beforeAll(async () => {
    await store.init();
    machineId = (await store.importPackage({ name: '01.aasx', package: golden() })).id;
  });
  afterAll(async () => {
    await simulator.stop();
  });

  it('one button press — tags are created, a collection connection appears, and values actually arrive', async () => {
    const res = await call('POST', `/packages/${machineId}/simulate`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ machine: 'RollFormingMachine', title: SIMULATOR_TITLE });
    expect(res.body.tags).toBeGreaterThan(0);
    expect(res.body.endpoint).toBe(`opc.tcp://127.0.0.1:${PORT}/UA/Simulator`);

    const collected = await call('POST', `/packages/${machineId}/collect`);
    expect(collected.status).toBe(200);
    expect(collected.body.collected).toBe(res.body.tags);
    const values = (await call('GET', `/packages/${machineId}/values`)).body.result;
    expect(values.every((v: any) => v.quality === 'Good')).toBe(true);
  }, 60_000);

  it('pressing again gives the same connection — tags are not duplicated', async () => {
    const again = await call('POST', `/packages/${machineId}/simulate`);
    expect(again.status).toBe(201);
    const { interfaces } = (await call('GET', `/packages/${machineId}/interfaces`)).body;
    expect(interfaces).toHaveLength(1);
    expect(interfaces[0].properties).toHaveLength(again.body.tags);
  });

  it('Important: does not overwrite equipment already connected to another address (field PLC) — 409', async () => {
    const other = (await store.importPackage({ name: 'site.aasx', package: golden() })).id;
    await call('POST', `/packages/${other}/aid`, {
      endpoint: 'opc.tcp://192.168.10.25:4840/PLC',
      tags: [{ name: 'MachineState', href: 'ns=2;s=MS', type: 'string' }],
    });
    const res = await call('POST', `/packages/${other}/simulate`);
    expect(res.status).toBe(409);
  });

  it('does not attach to a process (group) file — 400', async () => {
    const proc = (await call('POST', '/packages/new', { assetName: 'Line', unit: 'composite' })).body.packageId;
    expect((await call('POST', `/packages/${proc}/simulate`)).status).toBe(400);
  });

  it('501 on a deployment with collection off', async () => {
    const bare = createApi(new InMemoryStore());
    const response = await bare({ method: 'POST', path: `/packages/x/simulate`, query: {}, queryAll: {}, headers: {} } as ApiRequest);
    expect(response.status).toBe(501);
  });
});
