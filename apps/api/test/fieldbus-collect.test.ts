/**
 * Modbus TCP / MQTT collection — the same path the UI calls: create AID (POST /aid) -> rule check -> collect (POST /collect) -> query values.
 * Connects to the test device and test broker from @aas/fieldbus instead of real hardware. Reader selection matches server.ts.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { McReader, ModbusReader, ModbusTestServer, MqttReader, MqttTestBroker, S7Reader } from '@aas/fieldbus';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { McMockServer } from '../../../packages/fieldbus/test/mc-mock-server.js';
import { S7MockServer } from '../../../packages/fieldbus/test/s7-mock-server.js';

const golden = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')));

const openReader = async (descriptor: AidInterface): Promise<ProtocolReader> => {
  if (descriptor.protocol === 'MODBUS') return ModbusReader.connect(descriptor, { timeoutMs: 1000 });
  if (descriptor.protocol === 'MQTT') return MqttReader.connect(descriptor, { settleMs: 150, timeoutMs: 1000 });
  if (descriptor.protocol === 'S7') return S7Reader.connect(descriptor, { timeoutMs: 1000 });
  if (descriptor.protocol === 'MC') return McReader.connect(descriptor, { timeoutMs: 1000 });
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

describe('Modbus / MQTT collection — from creating the AID to values', () => {
  let device: ModbusTestServer | undefined;
  let broker: MqttTestBroker | undefined;
  afterEach(async () => {
    await device?.close();
    await broker?.close();
  });

  it('Modbus — the created AID adds no rule violations, and collecting accumulates values', async () => {
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

  it('MQTT — reads and accumulates retained values, and reports topics that never arrived as awaiting value', async () => {
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

describe('S7 / MC collection (VEXPLOR extension bindings) — from creating the AID to values', () => {
  let s7: S7MockServer | undefined;
  let mc: McMockServer | undefined;
  afterEach(async () => {
    await s7?.close();
    await mc?.close();
  });

  it('S7 — the created AID adds no rule violations, values accumulate, a missing DB is a failure with its reason', async () => {
    const h = await harness();
    const before = await h.errors();
    s7 = new S7MockServer();
    const db = Buffer.alloc(8);
    db.writeFloatBE(42.5, 4);
    s7.dbs.set(10, db);
    s7.areas.M[10] = 0b1000;
    const port = await s7.listen();
    const made = await h.call('POST', `/packages/${h.id}/aid`, {
      endpoint: `s7://127.0.0.1:${port}?rack=0&slot=1`,
      tags: [
        { name: 'Speed', href: 'DB10.DBD4:REAL', type: 'float' },
        { name: 'Running', href: 'M10.3', type: 'boolean' },
        { name: 'Missing', href: 'DB99.DBW0:INT', type: 'integer' },
      ],
    });
    expect(made.status).toBe(201);
    expect(await h.errors()).toEqual(before);
    const collected = await h.call('POST', `/packages/${h.id}/collect`);
    expect(JSON.stringify(collected.body)).toContain('ObjectDoesNotExist');
    const values = (await h.call('GET', `/packages/${h.id}/values`)).body['result'] as { propertyName: string; valueNumber?: number }[];
    expect(Object.fromEntries(values.filter((v) => v.valueNumber !== undefined).map((v) => [v.propertyName, v.valueNumber]))).toEqual({ Speed: 42.5, Running: 1 });
  });

  it('MC — values accumulate; an address the grammar refuses is a 400 with the reason, not a broken file', async () => {
    const h = await harness();
    const before = await h.errors();
    mc = new McMockServer();
    mc.memory.get(0xa8)![100] = 1234;
    mc.memory.get(0x90)![5] = 1;
    const port = await mc.listen();
    const made = await h.call('POST', `/packages/${h.id}/aid`, {
      endpoint: `melsec://127.0.0.1:${port}?series=Q`,
      tags: [
        { name: 'Counter', href: 'D100:INT', type: 'integer' },
        { name: 'Running', href: 'M5', type: 'boolean' },
      ],
    });
    expect(made.status).toBe(201);
    expect(await h.errors()).toEqual(before);
    await h.call('POST', `/packages/${h.id}/collect`);
    const values = (await h.call('GET', `/packages/${h.id}/values`)).body['result'] as { propertyName: string; valueNumber?: number }[];
    expect(Object.fromEntries(values.map((v) => [v.propertyName, v.valueNumber]))).toEqual({ Counter: 1234, Running: 1 });
    const refused = await h.call('POST', `/packages/${h.id}/aid`, { endpoint: `melsec://127.0.0.1:${port}`, tags: [{ name: 'Bad', href: 'M5:INT' }] });
    expect(refused.status).toBe(400);
  });
});

describe('collection link with security and a read period (2.8.0)', () => {
  it('OPC UA Sign + login + period, and MQTT login — the created AID adds no rule violations', async () => {
    const h = await harness();
    const before = await h.errors();
    const ua = await h.call('POST', `/packages/${h.id}/aid`, {
      endpoint: 'opc.tcp://192.168.0.50:4840',
      security: { mode: 'SignAndEncrypt', policy: 'Basic256Sha256', login: true },
      intervalMs: 1000,
      tags: [{ name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float', unit: 'rpm' }],
    });
    expect(ua.status).toBe(201);
    expect(await h.errors()).toEqual(before);
    const listed = (await h.call('GET', `/packages/${h.id}/interfaces`)).body['interfaces'] as { security?: unknown }[];
    expect(listed[0]!.security).toEqual({ mode: 'SignAndEncrypt', policy: 'Basic256Sha256', userIdentityToken: 'UserName' });

    const mqtt = await h.call('POST', `/packages/${h.id}/aid`, { endpoint: 'mqtt://broker.local:1883', security: { login: true }, tags: [{ name: 'Temperature', href: 'plant/m1/temp', type: 'float' }] });
    expect(mqtt.status).toBe(201);
    expect(await h.errors()).toEqual(before);
  });

  it('refuses a password in the address with a reason (400), and the file stays as it was', async () => {
    const h = await harness();
    const refused = await h.call('POST', `/packages/${h.id}/aid`, { endpoint: 'mqtt://aas:secret@broker.local:1883', tags: [{ name: 'T', href: 'a/b' }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await h.store.getEnvironment(h.id))).not.toContain('secret');
  });

  it('"Load from equipment" connects with the security the screen chose', async () => {
    const store = new InMemoryStore();
    await store.init();
    const seen: unknown[] = [];
    const handle = createApi(store, { browseDevice: async (endpoint: string, options?: unknown) => (seen.push({ endpoint, options }), { endpoint, truncated: false, nodes: [] }) } as never);
    const response = await handle({ method: 'POST', path: '/opcua/browse', query: {}, queryAll: {}, headers: { 'content-type': 'application/json' }, body: { endpoint: 'opc.tcp://10.0.0.5:4840', security: { mode: 'Sign', policy: 'Basic256Sha256', login: true } } } as ApiRequest);
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ endpoint: 'opc.tcp://10.0.0.5:4840', options: { security: { mode: 'Sign', policy: 'Basic256Sha256', login: true } } }]);
  });
});
