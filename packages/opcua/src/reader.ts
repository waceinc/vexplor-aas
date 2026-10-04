/**
 * OPC UA Client 어댑터 — 기획서 M8 · 인터페이스 우선순위 3.
 *
 * `node-opcua`(MIT)를 쓴다. Python/asyncua는 LGPL-3.0이라 공개·상용화에 제약이 붙는다
 * (CLAUDE.md 기술 스택). 이 파일이 프로토콜을 아는 **유일한 자리**이고,
 * 나머지(@aas/collector)는 포트만 본다 — 장비 없이 시험할 수 있어야 하기 때문이다.
 *
 * 읽기 실패를 예외로 올리지 않는다. 태그 하나가 나쁘다고 수집 전체가 멈추면 안 되고,
 * **나쁜 값은 버리지 않고 사유와 함께 남기는 것**이 A안의 감사 가능성과도 맞다.
 */
import type { ProtocolReader, ReadResult } from '@aas/collector';
import {
  AttributeIds,
  OPCUAClient,
  StatusCodes,
  TimestampsToReturn,
  type ClientSession,
  type DataValue,
} from 'node-opcua';

/**
 * 🔴 **「아직 값이 없다」는 뜻의 StatusCode 모음** — 「읽다 실패했다」와 가르는 자리.
 *
 * 우리 산출물은 Type/Template이라 빈 값이 정상이고(PROGRESS §4 설계 5번), 설비도 기동 직후에는
 * 여기 있는 상태를 준다. 전부 실패로 세면 멀쩡한 설비가 「나쁜 태그 60」으로 보이고,
 * 초보 사용자는 고장으로 읽는다.
 *
 * 🔴 **숫자를 손으로 적지 않는다.** node-opcua의 `StatusCodes`에서 꺼내 `.value`를 모은다 —
 *    상수를 옮겨 적으면 오타 하나로 조용히 어긋나고, 아무 시험도 그것을 잡지 못한다.
 *
 * 고른 기준은 "**변수에 아직 값이 없다**"는 뜻인 것뿐이다. 아래는 일부러 **뺐다**:
 *  - `BadNoCommunication` — 통신 자체가 안 선 것. 진짜 문제다
 *  - `BadOutOfService` — 데이터원이 동작하지 않는다. 진짜 문제다
 *  - `UncertainNoCommunicationLastUsableValue` — 값은 있다(마지막 정상값). 대기가 아니다
 */
const PENDING_STATUS: ReadonlySet<number> = new Set(
  [
    StatusCodes.BadWaitingForInitialData, // 데이터원에서 값을 받아 오는 중
    StatusCodes.BadNoValue, // 기본값도 초기값도 없는 변수
    StatusCodes.BadNoData, // 요청한 범위에 데이터가 없다
    StatusCodes.GoodNoData, // 위와 같으나 심각도가 Good
    StatusCodes.UncertainInitialValue, // 다른 변수에서 값을 받아야 하는데 아직 초기값
  ].map((code) => code.value),
);

export interface OpcUaOptions {
  /** opc.tcp://host:port — AID의 EndpointMetadata.base가 그대로 들어온다 */
  endpoint: string;
  /**
   * 접속 제한시간(ms). 기본 5초.
   *
   * 🔴 node-opcua는 자체 재시도를 하느라 **응답 없는 주소에서 60초를 매달린다**(실측).
   * 현장에서 장비 하나가 꺼져 있다고 수집 주기가 통째로 밀리면 안 되므로 우리가 끊는다.
   */
  connectTimeoutMs?: number;
}

/** 제한시간을 건다. 시간이 지나면 그 자리에서 끊고 사유를 남긴다 */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}이(가) ${ms}ms 안에 끝나지 않았습니다.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** DataValue → 우리 결과. 시각은 **장비가 준 것**을 우선한다 */
export function toReadResult(source: string, dataValue: DataValue): ReadResult {
  const status = dataValue.statusCode;
  const timestamp = dataValue.sourceTimestamp ?? dataValue.serverTimestamp;
  const result: ReadResult = { source, value: dataValue.value?.value ?? null };

  if (timestamp) result.observedAt = timestamp.toISOString();
  if (status) result.quality = status.name;
  // isNot('Good')가 아니라 값이 없는 경우까지 포함해 본다
  if (status && status.value !== 0) {
    if (PENDING_STATUS.has(status.value)) {
      // 🔴 아직 안 들어온 것 — 실패가 아니다. 다만 성공으로 위장하지도 않는다:
      //    값을 null로 지워 수집기가 표본을 만들 수 없게 한다(시계열에 가짜 값 금지).
      //    `UncertainInitialValue`처럼 자리채움 값을 함께 주는 상태가 있어서 반드시 지운다
      result.pending = true;
      result.value = null;
    } else {
      result.error = `${status.name}: ${status.description ?? '나쁜 상태'}`;
    }
  }
  return result;
}

export class OpcUaReader implements ProtocolReader {
  private constructor(
    readonly base: string,
    private readonly client: OPCUAClient,
    private readonly session: ClientSession,
  ) {}

  static async connect(options: OpcUaOptions): Promise<OpcUaReader> {
    const timeout = options.connectTimeoutMs ?? 5000;
    const client = OPCUAClient.create({
      // 현장 장비는 엔드포인트 목록을 정확히 주지 않는 일이 흔하다.
      // 서버가 광고하는 호스트명(.local 등)을 우리가 못 푸는 경우도 있어 주소를 그대로 쓴다
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 0, initialDelay: 200, maxDelay: 1000 },
      requestedSessionTimeout: Math.max(timeout, 10_000),
    });

    try {
      await withTimeout(client.connect(options.endpoint), timeout, '접속');
      const session = await withTimeout(client.createSession(), timeout, '세션 열기');
      return new OpcUaReader(options.endpoint, client, session);
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      throw error instanceof Error
        ? new Error(`${options.endpoint} 접속 실패: ${error.message}`)
        : error;
    }
  }

  /** 주소(NodeId) 목록을 한 번의 요청으로 읽는다 — 태그마다 왕복하면 현장에서 느리다 */
  async read(sources: readonly string[]): Promise<ReadResult[]> {
    if (sources.length === 0) return [];

    const nodesToRead = sources.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value }));
    let dataValues: DataValue[];
    try {
      dataValues = await this.session.read(nodesToRead, TimestampsToReturn.Both);
    } catch (error) {
      // 연결이 끊겼을 때 — 전부 실패로 표시하고 수집기가 판단하게 한다
      const reason = error instanceof Error ? error.message : String(error);
      return sources.map((source) => ({ source, value: null, error: `읽기 실패: ${reason}` }));
    }

    return sources.map((source, index) => {
      const dataValue = dataValues[index];
      if (!dataValue) return { source, value: null, error: '응답이 없습니다.' };
      return toReadResult(source, dataValue);
    });
  }

  async close(): Promise<void> {
    // 닫기 실패로 수집 주기를 깨뜨리지 않는다
    await this.session.close().catch(() => undefined);
    await this.client.disconnect().catch(() => undefined);
  }
}
