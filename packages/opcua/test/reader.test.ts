/**
 * OPC UA 어댑터 검증 — 내장 서버를 상대로 실제 프로토콜 왕복.
 *
 * 여기서 확인하는 것은 셋이다.
 *  ① NodeId로 값을 읽어 오는가
 *  ② 장비가 준 시각·품질을 그대로 싣는가
 *  ③ 나쁜 태그 하나가 나머지 수집을 멈추지 않는가
 */
import { OpcUaReader, toReadResult } from '@aas/opcua';
import { DataType, DataValue, StatusCodes, Variant } from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './server.js';

let server: TestServer;
let reader: OpcUaReader;

beforeAll(async () => {
  // 포트가 겹치면 다른 포트로 한 번 더 시도한다(다른 시험이 동시에 돌 수 있다)
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

describe('OPC UA 읽기', () => {
  it('NodeId로 값을 읽는다', async () => {
    const results = await reader.read(['ns=1;s=Machine.MotorSpeed', 'ns=1;s=Machine.AlarmActive']);
    expect(results).toHaveLength(2);

    const speed = results[0]!;
    expect(speed.value).toBe(1200.5);
    expect(speed.error).toBeUndefined();
    expect(speed.quality).toBe('Good');
    // 장비가 준 시각을 싣는다 — 수집기 시계가 아니다
    expect(speed.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(results[1]!.value).toBe(false);
  });

  it('값이 바뀌면 다음 읽기에 따라온다', async () => {
    server.setSpeed(1555.25);
    const [result] = await reader.read(['ns=1;s=Machine.MotorSpeed']);
    expect(result!.value).toBe(1555.25);
  });

  it('나쁜 태그는 사유와 함께 표시하고 나머지는 계속 읽는다', async () => {
    const results = await reader.read([
      'ns=1;s=Machine.BrokenSensor',
      'ns=1;s=Machine.MotorSpeed',
    ]);
    expect(results[0]!.error).toContain('BadDeviceFailure');
    expect(results[0]!.quality).toBe('BadDeviceFailure');
    // 하나가 나빠도 나머지는 정상이다 — 수집이 통째로 멈추면 안 된다
    expect(results[1]!.error).toBeUndefined();
    expect(results[1]!.value).toBe(1555.25);
  });

  it('🔴 아직 값이 없는 태그를 고장 난 태그와 섞지 않는다', async () => {
    // 이 둘은 이름이 모두 Bad로 시작해 얼핏 같아 보인다. 그러나 하나는 정상 대기,
    // 하나는 진짜 고장이다 — 섞으면 멀쩡한 설비가 「나쁜 태그 N」으로 보인다
    const [waiting, broken] = await reader.read([
      'ns=1;s=Machine.NotYetReady',
      'ns=1;s=Machine.BrokenSensor',
    ]);

    expect(waiting!.pending).toBe(true);
    expect(waiting!.error).toBeUndefined(); // 실패가 아니다
    expect(waiting!.quality).toBe('BadWaitingForInitialData'); // 근거는 숨기지 않는다
    expect(waiting!.value).toBeNull(); // 🔴 성공으로 위장하지도 않는다

    expect(broken!.pending).toBeUndefined();
    expect(broken!.error).toContain('BadDeviceFailure');
  });

  it('없는 NodeId도 예외가 아니라 결과로 돌려준다', async () => {
    const [result] = await reader.read(['ns=1;s=없는태그']);
    expect(result!.error).toBeDefined();
    expect(result!.quality).toContain('Bad');
  });

  it('빈 목록은 그냥 빈 결과', async () => {
    expect(await reader.read([])).toEqual([]);
  });
});

describe('접속 제한시간', () => {
  it('응답 없는 주소에서 오래 매달리지 않는다', async () => {
    // node-opcua 기본 동작은 60초를 매단다(실측). 장비 하나가 꺼져 있다고
    // 수집 주기가 통째로 밀리면 안 된다
    const started = Date.now();
    await expect(
      OpcUaReader.connect({ endpoint: 'opc.tcp://127.0.0.1:14999/없음', connectTimeoutMs: 1500 }),
    ).rejects.toThrow(/접속 실패/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

/**
 * 상태 코드 분류 — 시험용 서버로는 한 가지 상태밖에 못 만들어서 여기서 나머지를 붙든다.
 *
 * 🔴 경계가 어디인지를 시험이 문서로 들고 있어야 한다. 나중에 "이것도 대기 아닌가?" 하고
 *    코드를 늘릴 때, 뺀 것들이 왜 실패인지가 여기 적혀 있어야 판단이 선다.
 */
describe('toReadResult — 「값 대기」와 「읽기 실패」의 경계', () => {
  const of = (status: (typeof StatusCodes)['Good'], value: unknown = 0): ReturnType<typeof toReadResult> =>
    toReadResult(
      'ns=1;s=X',
      new DataValue({
        statusCode: status,
        value: new Variant({ dataType: DataType.Double, value }),
      }),
    );

  it('값 없음 계열은 대기로 본다', () => {
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

  it('🔴 자리채움 값이 붙어 와도 값으로 흘리지 않는다', () => {
    // UncertainInitialValue는 초기값을 함께 준다. 그대로 두면 시계열에 0이 쌓이고
    // "설비가 0을 보냈다"는 가짜 이력이 남는다
    const result = of(StatusCodes.UncertainInitialValue, 0);
    expect(result.pending).toBe(true);
    expect(result.value).toBeNull();
  });

  it('🔴 진짜 문제는 그대로 실패다 — 대기로 덮어 숨기지 않는다', () => {
    for (const status of [
      StatusCodes.BadDeviceFailure, // 센서가 죽었다
      StatusCodes.BadNoCommunication, // 통신이 안 선다
      StatusCodes.BadOutOfService, // 데이터원이 동작하지 않는다
      StatusCodes.BadNodeIdUnknown, // 주소가 틀렸다
      StatusCodes.UncertainNoCommunicationLastUsableValue, // 값은 있으나 통신이 끊겼다
    ]) {
      const result = of(status);
      expect(result.pending, status.name).toBeUndefined();
      expect(result.error, status.name).toContain(status.name);
    }
  });

  it('정상 값은 둘 다 아니다', () => {
    const result = of(StatusCodes.Good, 12.5);
    expect(result.pending).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(12.5);
  });
});
