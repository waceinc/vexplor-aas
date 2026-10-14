/**
 * Modbus TCP · MQTT 수집 — 화면이 부르는 길 그대로: AID 만들기(POST /aid) → 규칙 검사 → 수집(POST /collect) → 값 조회.
 * 실장비 대신 @aas/fieldbus 의 시험 장치 · 시험 브로커에 붙는다. 리더 선택은 server.ts 와 같다.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { ModbusReader, ModbusTestServer, MqttReader, MqttTestBroker } from '@aas/fieldbus';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const golden = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')));

const openReader = async (descriptor: AidInterface): Promise<ProtocolReader> => {
  if (descriptor.protocol === 'MODBUS') return ModbusReader.connect(descriptor, { timeoutMs: 1000 });
  if (descriptor.protocol === 'MQTT') return MqttReader.connect(descriptor, { settleMs: 150, timeoutMs: 1000 });
  throw new Error(`아직 지원하지 않는 프로토콜입니다: ${descriptor.protocol}`);
};

async function harness() {
  const store = new InMemoryStore();
  await store.init();
  const id = (await store.importPackage({ name: 'm.aasx', package: golden() })).id;
  const handle = createApi(store, { openReader });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle({ method, path, query: {}, queryAll: {}, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body } : {}) } as ApiRequest);
    return { status: response.status, body: response.body as Record<string, unknown> };
  };
  const errors = async (): Promise<string[]> =>
    ((await call('GET', `/packages/${id}/lint`)).body['findings'] as { ruleId: string; severity: string }[]).filter((f) => f.severity === 'error').map((f) => f.ruleId);
  return { store, id, call, errors };
}

describe('Modbus · MQTT 수집 — AID 만들기부터 값까지', () => {
  let device: ModbusTestServer | undefined;
  let broker: MqttTestBroker | undefined;
  afterEach(async () => {
    await device?.close();
    await broker?.close();
  });

  it('Modbus — 만든 AID 가 규칙 위반을 더하지 않고, 수집하면 값이 쌓인다', async () => {
    const h = await harness();
    const before = await h.errors();
    device = new ModbusTestServer();
    const port = await device.listen();
    device.tables.HoldingRegister.set(40, 777);
    device.tables.Coil.set(5, 1);
    const made = await h.call('POST', `/packages/${h.id}/aid`, {
      endpoint: `modbus+tcp://127.0.0.1:${port}/1`,
      tags: [
        { name: 'Counter', href: '40', type: 'integer', form: { modv_entity: 'HoldingRegister', modv_type: 'xsd:unsignedShort' } },
        { name: 'Running', href: '5', type: 'boolean', form: { modv_function: 'readCoil' } },
      ],
    });
    expect(made.status).toBe(201);
    expect(await h.errors()).toEqual(before);

    const collected = await h.call('POST', `/packages/${h.id}/collect`);
    expect(collected.status).toBe(200);
    const values = (await h.call('GET', `/packages/${h.id}/values`)).body['result'] as { propertyName: string; valueNumber?: number }[];
    expect(Object.fromEntries(values.map((v) => [v.propertyName, v.valueNumber]))).toEqual({ Counter: 777, Running: 1 });
  });

  it('MQTT — 보관된 값을 읽어 쌓고, 안 온 토픽은 값 대기로 보고한다', async () => {
    const h = await harness();
    const before = await h.errors();
    broker = new MqttTestBroker();
    const port = await broker.listen();
    broker.publish('plant/m1/temp', '36.6', true);
    const made = await h.call('POST', `/packages/${h.id}/aid`, {
      endpoint: `mqtt://127.0.0.1:${port}`,
      tags: [
        { name: 'Temperature', href: 'plant/m1/temp', type: 'float', form: { mqv_controlPacket: 'subscribe' } },
        { name: 'Pressure', href: 'plant/m1/pressure', type: 'float' },
      ],
    });
    expect(made.status).toBe(201);
    expect(await h.errors()).toEqual(before);
    const collected = await h.call('POST', `/packages/${h.id}/collect`);
    expect(JSON.stringify(collected.body)).toContain('Pressure');
    const values = (await h.call('GET', `/packages/${h.id}/values`)).body['result'] as { propertyName: string; valueNumber?: number }[];
    expect(values.map((v) => [v.propertyName, v.valueNumber])).toEqual([['Temperature', 36.6]]);
  });
});
