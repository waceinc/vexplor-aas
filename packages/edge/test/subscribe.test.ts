/**
 * Report by exception (lead request §6 H4): with `"opcua": { "mode": "subscribe" }` the edge sends a value when the PLC
 * reports a change, not on every interval — against a real AAS Studio server (EDGE=on) and a real OPC UA server.
 *
 *  (1) an unchanged value is not sent again on every interval; polling the same tags sends it every time
 *  (2) a change is sent, and an unchanged value is sent again after `resendMs` with a new receive time
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { createHttpServer } from '@aas/api';
import { buildAidSubmodel } from '@aas/collector';
import { InMemoryStore } from '@aas/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EdgeAgent, parseEdgeConfig } from '../src/index.js';
import { isAnalogType } from '../src/readers.js';
import { startTestServer, type TestServer } from '../../opcua/test/server.js';

let opcua: TestServer;
const golden = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));
const saved = process.env['EDGE'];

beforeAll(async () => {
  process.env['EDGE'] = 'on';
  try {
    opcua = await startTestServer(14960);
  } catch {
    opcua = await startTestServer(14961);
  }
}, 60_000);

afterAll(async () => {
  await opcua?.stop();
  if (saved === undefined) delete process.env['EDGE'];
  else process.env['EDGE'] = saved;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return response.json();
}

/**
 * AAS Studio with one file (two OPC UA tags), and an approved edge reading them every `intervalMs`.
 * Important: the first test uses 1 s — a subscription at 1 s was once refused by the OPC UA client (keep-alive longer
 *    than the session timeout) and the edge quietly polled instead; 200 ms did not show it.
 */
async function world(opcuaSettings: Record<string, unknown>, intervalMs = 200) {
  const store = new InMemoryStore();
  const pkg = readAasx(golden);
  pkg.environment.submodels!.push(
    buildAidSubmodel({
      assetName: 'RollFormingMachine',
      iriBase: 'https://www.smart-factory.kr/ids',
      endpoint: opcua.endpoint,
      tags: [
        { name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float' },
        { name: 'CycleCount', href: 'ns=1;s=Machine.CycleCount', type: 'integer' },
      ],
    }) as never,
  );
  const record = await store.importPackage({ name: 'line1.aasx', package: pkg });
  const server = createHttpServer({ store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const { code } = (await call(port, 'POST', '/edge/registration-codes')) as { code: string };
  const config = parseEdgeConfig(
    JSON.stringify({ server: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'edge-sub-')), flushIntervalMs: 150, opcua: opcuaSettings }),
    join(tmpdir(), 'edge.json'),
  );
  const agent = new EdgeAgent({ config, credentials: new Map() });
  const { deviceId } = await agent.register(code);
  const preview = (await call(port, 'GET', `/edge/devices/${deviceId}/read-list-preview`)) as { revision: string; interfaces: { interfaceId: string }[] };
  await call(port, 'POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [preview.interfaces[0]!.interfaceId]: intervalMs } });
  const stored = async () => store.readValues(record.id, { limit: 100_000 });
  const done = async () => {
    await agent.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return { agent, stored, done };
}

describe('report by exception (OPC UA subscribe)', () => {
  it('the deadband is for analog types only — never integers (counters), booleans or text', () => {
    expect(['float', 'double', 'xs:double', 'decimal'].every(isAnalogType)).toBe(true);
    expect(['integer', 'int', 'xs:unsignedInt', 'long', 'boolean', 'string', undefined].some(isAnalogType)).toBe(false);
  });

  it('sends an unchanged value once, where polling the same tags sends it every interval', async () => {
    opcua.setSpeed(1500);
    const polled = await world({ mode: 'poll' }, 1000);
    const subscribed = await world({ mode: 'subscribe', resendMs: 600_000 }, 1000);
    try {
      await Promise.all([polled.agent.start(), subscribed.agent.start()]);
      await sleep(4000);
      const poll = (await polled.stored()).length;
      const sub = await subscribed.stored();
      // 2 tags every second for ~4 s, against the 2 first values
      expect(poll).toBeGreaterThanOrEqual(6);
      expect(sub).toHaveLength(2);
      expect(sub.map((value) => value.valueNumber).sort()).toEqual([1500, 5200]);
    } finally {
      await polled.done();
      await subscribed.done();
    }
  }, 60_000);

  it('the deadband skips a small analog change and passes a large one', async () => {
    opcua.setSpeed(1700);
    const { agent, stored, done } = await world({ mode: 'subscribe', deadband: 10, resendMs: 600_000 });
    try {
      await agent.start();
      await sleep(1500);
      opcua.setSpeed(1705);
      await sleep(1500);
      opcua.setSpeed(1720);
      await sleep(1500);
      const speeds = (await stored()).filter((value) => value.propertyName === 'MotorSpeed').map((value) => value.valueNumber);
      // 1705 is within the deadband of 10 — never sent
      expect(speeds.sort()).toEqual([1700, 1720]);
    } finally {
      await done();
    }
  }, 60_000);

  it('sends a change, and an unchanged value again after resendMs with a new receive time', async () => {
    opcua.setSpeed(1600);
    const { agent, stored, done } = await world({ mode: 'subscribe', resendMs: 2000 });
    try {
      await agent.start();
      await sleep(1500);
      expect(await stored()).toHaveLength(2);
      opcua.setSpeed(1650);
      await sleep(2000);
      const speeds = (await stored()).filter((value) => value.propertyName === 'MotorSpeed').map((value) => value.valueNumber);
      expect(speeds).toContain(1650);
      await sleep(3000);
      // CycleCount never changed: it came again, same device time, later receive time
      const counts = (await stored()).filter((value) => value.propertyName === 'CycleCount');
      expect(counts.length).toBeGreaterThanOrEqual(2);
      expect(new Set(counts.map((value) => value.observedAt)).size).toBe(1);
      expect(new Set(counts.map((value) => value.receivedAt)).size).toBe(counts.length);
    } finally {
      await done();
    }
  }, 60_000);
});
