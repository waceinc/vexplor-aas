/**
 * 설비 훑기 검증 — **진짜 OPC UA 서버**를 상대로 한다.
 *
 * 손으로 치던 NodeId를 없애는 기능이라, 「진짜 그 주소가 나오는가」가 전부다.
 * 가짜 객체로 시험하면 그걸 알 수 없다(M8 e2e와 같은 원칙).
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
  it('🔴 DataType은 **NodeId 번호로 온다** — 이름인 줄 알면 전부 string이 된다', () => {
    expect(aidTypeOf('ns=0;i=1')).toBe('boolean');
    expect(aidTypeOf('ns=0;i=6')).toBe('integer'); // Int32
    expect(aidTypeOf('ns=0;i=11')).toBe('float'); // Double
    expect(aidTypeOf('ns=0;i=12')).toBe('string');
    expect(aidTypeOf('i=10')).toBe('float'); // Float — 접두사 없이 오기도 한다
  });

  it('이름으로 오는 경우(벤더 자료형)도 읽는다', () => {
    expect(aidTypeOf('Boolean')).toBe('boolean');
    expect(aidTypeOf('Double')).toBe('float');
    expect(aidTypeOf('Int32')).toBe('integer');
    expect(aidTypeOf(undefined)).toBe('string');
  });
});

describe('showValue', () => {
  it('배열·구조체는 펼치지 않는다 — 목록이 읽히지 않게 된다', () => {
    expect(showValue([1, 2, 3])).toBe('[3개]');
    expect(showValue({ a: 1 })).toBe('(구조체)');
    expect(showValue(12.5)).toBe('12.5');
    expect(showValue(null)).toBeUndefined();
  });
});

describe('browseDevice', () => {
  it('설비에 붙어 태그를 주소째로 가져온다', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    const names = result.nodes.map((node) => node.name);
    expect(names).toContain('MotorSpeed');
    expect(names).toContain('AlarmActive');

    const speed = result.nodes.find((node) => node.name === 'MotorSpeed')!;
    // 🔴 이 값이 그대로 AID의 href가 된다 — 손으로 칠 필요가 없어지는 지점
    expect(speed.nodeId).toBe('ns=1;s=Machine.MotorSpeed');
    expect(speed.type).toBe('float');
    expect(speed.value).toBe('1200.5');
    // 어디에 있는 것인지 사람이 알아보게
    expect(speed.path).toContain('Machine');
  }, 30_000);

  it('불린 태그를 불린으로 잡는다', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    const alarm = result.nodes.find((node) => node.name === 'AlarmActive')!;
    expect(alarm.type).toBe('boolean');
    expect(alarm.value).toBe('false');
  }, 30_000);

  it('🔴 정수 값을 가진 정수 태그를 string으로 떨어뜨리지 않는다', async () => {
    // 값(5200)만 보면 float인지 int인지 알 수 없다 — DataType을 제대로 읽어야만 맞는다
    const result = await browseDevice({ endpoint: server.endpoint });
    const count = result.nodes.find((node) => node.name === 'CycleCount')!;
    expect(count.type).toBe('integer');
    expect(count.value).toBe('5200');
  }, 30_000);

  it('🔴 안 읽히는 태그도 목록에 남긴다 — 왜 안 되는지가 정보다', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    const broken = result.nodes.find((node) => node.name === 'BrokenSensor')!;
    expect(broken).toBeTruthy();
    expect(broken.error).toContain('Bad');
    expect(broken.value).toBeUndefined();
  }, 30_000);

  it('🔴 서버 자기 정보(ns=0)는 섞지 않는다 — 진짜 태그를 못 찾게 된다', async () => {
    const result = await browseDevice({ endpoint: server.endpoint });
    expect(result.nodes.every((node) => !node.nodeId.startsWith('ns=0;'))).toBe(true);
    expect(result.nodes.some((node) => node.name === 'ServerStatus')).toBe(false);
  }, 30_000);

  it('상한에 걸리면 잘랐다고 말한다 — 조용히 자르지 않는다', async () => {
    const result = await browseDevice({ endpoint: server.endpoint, maxNodes: 1 });
    expect(result.nodes).toHaveLength(1);
    expect(result.truncated).toBe(true);
  }, 30_000);

  it('못 붙으면 주소를 넣어 알려 준다', async () => {
    await expect(
      browseDevice({ endpoint: 'opc.tcp://127.0.0.1:1/UA/None', connectTimeoutMs: 1500 }),
    ).rejects.toThrow(/훑기 실패/);
  }, 30_000);
});
