/**
 * OPC UA subscriptions (report by exception, lead request §6 H4) — over the real protocol against the built-in server.
 *
 *  (1) the first value comes at once, then only changes
 *  (2) an absolute deadband hides small numeric changes and passes large ones
 *  (3) a boolean tag next to a deadband is still watched (no filter on it — the server would refuse one)
 */
import type { ReadResult } from '@aas/collector';
import { OpcUaReader } from '@aas/opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './server.js';

let server: TestServer;
let reader: OpcUaReader;

beforeAll(async () => {
  try {
    server = await startTestServer(14850);
  } catch {
    server = await startTestServer(14851);
  }
  reader = await OpcUaReader.connect({ endpoint: server.endpoint });
}, 60_000);

afterAll(async () => {
  await reader?.close();
  await server?.stop();
});

const SPEED = 'ns=1;s=Machine.MotorSpeed';
const ALARM = 'ns=1;s=Machine.AlarmActive';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `count` reports for `source` arrived, or the time is up */
async function until(results: ReadResult[], source: string, count: number, ms = 8000): Promise<ReadResult[]> {
  const end = Date.now() + ms;
  while (Date.now() < end && results.filter((result) => result.source === source).length < count) await sleep(100);
  return results.filter((result) => result.source === source);
}

describe('OPC UA subscribe', () => {
  it('reports the first value, then a value only when it changes', async () => {
    server.setSpeed(1000);
    const results: ReadResult[] = [];
    const subscription = await reader.subscribe([SPEED], { samplingIntervalMs: 250 }, (result) => results.push(result));
    try {
      expect((await until(results, SPEED, 1)).map((result) => result.value)).toEqual([1000]);
      // Nothing changes for a while: nothing more is reported
      await sleep(2500);
      expect(results).toHaveLength(1);
      server.setSpeed(1001);
      expect((await until(results, SPEED, 2)).map((result) => result.value)).toEqual([1000, 1001]);
      expect(results[1]!.quality).toBe('Good');
      expect(results[1]!.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await subscription.close();
    }
  }, 30_000);

  it('accepts intervals from 100 ms to a minute — the keep-alive is fitted to the session timeout', async () => {
    for (const samplingIntervalMs of [100, 1000, 5000, 60_000]) {
      const results: ReadResult[] = [];
      const subscription = await reader.subscribe([SPEED], { samplingIntervalMs }, (result) => results.push(result));
      expect((await until(results, SPEED, 1)).length, `${samplingIntervalMs} ms`).toBe(1);
      await subscription.close();
    }
  }, 60_000);

  it('a deadband hides a small change on a numeric tag and passes a large one; a boolean tag is still watched', async () => {
    server.setSpeed(2000);
    const results: ReadResult[] = [];
    const subscription = await reader.subscribe([SPEED, ALARM], { samplingIntervalMs: 250, deadband: 5, numeric: new Set([SPEED]) }, (result) =>
      results.push(result),
    );
    try {
      await until(results, SPEED, 1);
      expect((await until(results, ALARM, 1)).map((result) => result.value)).toEqual([false]);
      server.setSpeed(2003);
      await sleep(2500);
      expect((await until(results, SPEED, 1, 0)).map((result) => result.value)).toEqual([2000]);
      server.setSpeed(2010);
      expect((await until(results, SPEED, 2)).map((result) => result.value)).toEqual([2000, 2010]);
    } finally {
      await subscription.close();
    }
  }, 30_000);
});
