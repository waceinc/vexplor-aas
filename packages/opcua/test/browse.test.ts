/**
 * Device browse checks — run against a **real OPC UA server**.
 *
 * This feature removes hand-typed NodeIds, so the only question is whether the real address comes back.
 * A fake object cannot tell us that (same principle as the M8 e2e test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aidTypeOf, browseDevice, showValue } from '../src/browse.js';
import { startTestServer, type TestServer } from './server.js';

let server: TestServer;

beforeAll(async () => {
  try {
    server = await startTestServer(14880);
  } catch {
    server = await startTestServer(14881);
  }
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe('aidTypeOf', () => {
  it('Important: DataType arrives as a **NodeId number** — treating it as a name turns everything into string', () => {
    expect(aidTypeOf('ns=0;i=1')).toBe('boolean');
    expect(aidTypeOf('ns=0;i=6')).toBe('integer'); // Int32
    expect(aidTypeOf('ns=0;i=11')).toBe('float'); // Double
    expect(aidTypeOf('ns=0;i=12')).toBe('string');
    expect(aidTypeOf('i=10')).toBe('float'); // Float — sometimes arrives without the ns prefix
  });

  it('also reads DataTypes given by name (vendor types)', () => {
    expect(aidTypeOf('Boolean')).toBe('boolean');
    expect(aidTypeOf('Double')).toBe('float');
    expect(aidTypeOf('Int32')).toBe('integer');
    expect(aidTypeOf(undefined)).toBe('string');
  });
});

describe('showValue', () => {
  it('does not expand arrays or structures — the list would become unreadable', () => {
    expect(showValue([1, 2, 3])).toBe('[3개]');
    expect(showValue({ a: 1 })).toBe('(구조체)');
    expect(showValue(12.5)).toBe('12.5');
    expect(showValue(null)).toBeUndefined();
  });
});

describe('browseDevice', () => {
  it('connects to the device and fetches tags with their addresses', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    const names = result.nodes.map((node) => node.name);
    expect(names).toContain('MotorSpeed');
    expect(names).toContain('AlarmActive');

    const speed = result.nodes.find((node) => node.name === 'MotorSpeed')!;
    // Important: this value becomes the AID href as is — the point where hand-typing is no longer needed
    expect(speed.nodeId).toBe('ns=1;s=Machine.MotorSpeed');
    expect(speed.type).toBe('float');
    expect(speed.value).toBe('1200.5');
    // so a person can tell where it lives
    expect(speed.path).toContain('Machine');
  }, 30_000);

  it('detects boolean tags as boolean', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    const alarm = result.nodes.find((node) => node.name === 'AlarmActive')!;
    expect(alarm.type).toBe('boolean');
    expect(alarm.value).toBe('false');
  }, 30_000);

  it('Important: does not downgrade an integer tag holding an integer value to string', async () => {
    // From the value (5200) alone you cannot tell float from int — only reading DataType correctly gets it right
    const result = await browseDevice({ endpoint: server.endpoint });
    const count = result.nodes.find((node) => node.name === 'CycleCount')!;
    expect(count.type).toBe('integer');
    expect(count.value).toBe('5200');
  }, 30_000);

  it('Important: keeps unreadable tags in the list — why it fails is the information', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    const broken = result.nodes.find((node) => node.name === 'BrokenSensor')!;
    expect(broken).toBeTruthy();
    expect(broken.error).toContain('Bad');
    expect(broken.value).toBeUndefined();
  }, 30_000);

  it('Important: does not mix in the server\'s own info (ns=0) — real tags would get lost', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    expect(result.nodes.every((node) => !node.nodeId.startsWith('ns=0;'))).toBe(true);
    expect(result.nodes.some((node) => node.name === 'ServerStatus')).toBe(false);
  }, 30_000);

  it('says it truncated when the limit is hit — never truncates silently', async () => {
    const result = await browseDevice({ endpoint: server.endpoint, maxNodes: 1 });
    expect(result.nodes).toHaveLength(1);
    expect(result.truncated).toBe(true);
  }, 30_000);

  it('reports the address when it cannot connect', async () => {
    await expect(
      browseDevice({ endpoint: 'opc.tcp://127.0.0.1:1/UA/None', connectTimeoutMs: 1500 }),
    ).rejects.toThrow(/훑기 실패/);
  }, 30_000);
});
