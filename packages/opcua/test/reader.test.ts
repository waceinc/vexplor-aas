/**
 * OPC UA adapter checks — real protocol round-trips against the built-in server.
 *
 * Three things are checked here.
 *  (1) values are read by NodeId
 *  (2) the timestamp and quality supplied by the device are carried as is
 *  (3) one bad tag does not stop collection of the rest
 */
import { OpcUaReader, toReadResult } from '@aas/opcua';
import { DataType, DataValue, StatusCodes, Variant } from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './server.js';

let server: TestServer;
let reader: OpcUaReader;

beforeAll(async () => {
  // If the port is taken, try once more on another port (other tests may run concurrently)
  try {
    server = await startTestServer(14840);
  } catch {
    server = await startTestServer(14841);
  }
  reader = await OpcUaReader.connect({ endpoint: server.endpoint });
}, 60_000);

afterAll(async () => {
  await reader?.close();
  await server?.stop();
});

describe('OPC UA read', () => {
  it('reads values by NodeId', async () => {
    const results = await reader.read(['ns=1;s=Machine.MotorSpeed', 'ns=1;s=Machine.AlarmActive']);
    expect(results).toHaveLength(2);

    const speed = results[0]!;
    expect(speed.value).toBe(1200.5);
    expect(speed.error).toBeUndefined();
    expect(speed.quality).toBe('Good');
    // Carries the device-supplied timestamp — not the collector clock
    expect(speed.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(results[1]!.value).toBe(false);
  });

  it('follows value changes on the next read', async () => {
    server.setSpeed(1555.25);
    const [result] = await reader.read(['ns=1;s=Machine.MotorSpeed']);
    expect(result!.value).toBe(1555.25);
  });

  it('marks a bad tag with a reason and keeps reading the rest', async () => {
    const results = await reader.read([
      'ns=1;s=Machine.BrokenSensor',
      'ns=1;s=Machine.MotorSpeed',
    ]);
    expect(results[0]!.error).toContain('BadDeviceFailure');
    expect(results[0]!.quality).toBe('BadDeviceFailure');
    // One bad tag leaves the rest healthy — collection must not stop entirely
    expect(results[1]!.error).toBeUndefined();
    expect(results[1]!.value).toBe(1555.25);
  });

  it('Important: does not mix tags with no value yet into broken tags', async () => {
    // Both names start with Bad and look alike at a glance. But one is a normal wait,
    // the other a real failure — mixing them makes a healthy machine show "N bad tags"
    const [waiting, broken] = await reader.read([
      'ns=1;s=Machine.NotYetReady',
      'ns=1;s=Machine.BrokenSensor',
    ]);

    expect(waiting!.pending).toBe(true);
    expect(waiting!.error).toBeUndefined(); // not a failure
    expect(waiting!.quality).toBe('BadWaitingForInitialData'); // the evidence is not hidden
    expect(waiting!.value).toBeNull(); // Important: nor disguised as a success

    expect(broken!.pending).toBeUndefined();
    expect(broken!.error).toContain('BadDeviceFailure');
  });

  it('returns an unknown NodeId as a result, not an exception', async () => {
    const [result] = await reader.read(['ns=1;s=없는태그']);
    expect(result!.error).toBeDefined();
    expect(result!.quality).toContain('Bad');
  });

  it('an empty list yields an empty result', async () => {
    expect(await reader.read([])).toEqual([]);
  });
});

describe('connect timeout', () => {
  it('does not hang long on an unresponsive address', async () => {
    // node-opcua by default hangs for 60 s (measured). One device being off
    // must not push back the whole collection cycle
    const started = Date.now();
    await expect(
      OpcUaReader.connect({ endpoint: 'opc.tcp://127.0.0.1:14999/없음', connectTimeoutMs: 1500 }),
    ).rejects.toThrow(/접속 실패/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

/**
 * Status code classification — the test server can produce only one status, so the rest are pinned here.
 *
 * Important: the test must document where the boundary is. When someone later asks "isn't this a wait too?" and
 *    extends the code, the reasons the excluded codes are failures must be written here to decide.
 */
describe('toReadResult — boundary between "waiting for value" and "read failure"', () => {
  const of = (status: (typeof StatusCodes)['Good'], value: unknown = 0): ReturnType<typeof toReadResult> =>
    toReadResult(
      'ns=1;s=X',
      new DataValue({
        statusCode: status,
        value: new Variant({ dataType: DataType.Double, value }),
      }),
    );

  it('treats no-value statuses as waiting', () => {
    for (const status of [
      StatusCodes.BadWaitingForInitialData,
      StatusCodes.BadNoValue,
      StatusCodes.BadNoData,
      StatusCodes.GoodNoData,
      StatusCodes.UncertainInitialValue,
    ]) {
      const result = of(status);
      expect(result.pending, status.name).toBe(true);
      expect(result.error, status.name).toBeUndefined();
    }
  });

  it('Important: does not pass a placeholder value through as a value', () => {
    // UncertainInitialValue comes with an initial value. Left as is, 0s pile up in the time series
    // leaving a fake history saying "the machine sent 0"
    const result = of(StatusCodes.UncertainInitialValue, 0);
    expect(result.pending).toBe(true);
    expect(result.value).toBeNull();
  });

  it('Important: real problems stay failures — not hidden under waiting', () => {
    for (const status of [
      StatusCodes.BadDeviceFailure, // sensor is dead
      StatusCodes.BadNoCommunication, // no communication established
      StatusCodes.BadOutOfService, // data source is not running
      StatusCodes.BadNodeIdUnknown, // wrong address
      StatusCodes.UncertainNoCommunicationLastUsableValue, // a value exists but communication is lost
    ]) {
      const result = of(status);
      expect(result.pending, status.name).toBeUndefined();
      expect(result.error, status.name).toContain(status.name);
    }
  });

  it('a healthy value is neither', () => {
    const result = of(StatusCodes.Good, 12.5);
    expect(result.pending).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(12.5);
  });
});
