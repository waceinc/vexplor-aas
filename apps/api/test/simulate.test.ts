/**
 * 「가상 PLC로 연결」 — 설치판만 가진 평가자가 번들을 재현하는 길.
 *
 * 🔴 이 시험의 요점: **버튼 한 번으로 실제 OPC UA 수집까지 되는가.** 모의 객체가 아니라
 *    내장 가상 PLC(node-opcua 서버)에 실제로 붙어 값을 읽는다.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import type { AidInterface } from '@aas/collector';
import { OpcUaReader, SIMULATOR_TITLE, SimulatorServer } from '@aas/opcua';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const golden = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')));
const PORT = 14870 + Math.floor(Math.random() * 100);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('가상 PLC로 연결', () => {
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

  it('버튼 한 번 — 태그가 서고 수집 연결이 생기고, 실제로 값이 들어온다', async () => {
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

  it('다시 눌러도 같은 연결이다 — 태그가 두 벌로 늘지 않는다', async () => {
    const again = await call('POST', `/packages/${machineId}/simulate`);
    expect(again.status).toBe(201);
    const { interfaces } = (await call('GET', `/packages/${machineId}/interfaces`)).body;
    expect(interfaces).toHaveLength(1);
    expect(interfaces[0].properties).toHaveLength(again.body.tags);
  });

  it('🔴 이미 다른 주소(현장 PLC)로 연결된 설비는 덮지 않는다 — 409', async () => {
    const other = (await store.importPackage({ name: 'site.aasx', package: golden() })).id;
    await call('POST', `/packages/${other}/aid`, {
      endpoint: 'opc.tcp://192.168.10.25:4840/PLC',
      tags: [{ name: 'MachineState', href: 'ns=2;s=MS', type: 'string' }],
    });
    const res = await call('POST', `/packages/${other}/simulate`);
    expect(res.status).toBe(409);
  });

  it('공정(묶음) 파일에는 붙이지 않는다 — 400', async () => {
    const proc = (await call('POST', '/packages/new', { assetName: 'Line', unit: 'composite' })).body.packageId;
    expect((await call('POST', `/packages/${proc}/simulate`)).status).toBe(400);
  });

  it('수집이 꺼진 배포에서는 501', async () => {
    const bare = createApi(new InMemoryStore());
    const response = await bare({ method: 'POST', path: `/packages/x/simulate`, query: {}, queryAll: {}, headers: {} } as ApiRequest);
    expect(response.status).toBe(501);
  });
});
