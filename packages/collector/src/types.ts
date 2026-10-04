/**
 * 수집 계약 — 기획서 M8.
 *
 * 🔴 값 동기화 **A안**(docs/PROGRESS.md §2-2)이 이 설계를 지배한다.
 * 수집값은 **모델로 되돌아가지 않는다.** 산출물이 Type/Template이라 런타임 값을 되쓰면
 * 메타모델 의미 위반이고(KOSMO-AAS-6·SM-4), Package Explorer가 겪은 사고를 되풀이하게 된다.
 * 그래서 이 패키지의 어떤 함수도 Environment를 수정하지 않는다 — 읽기만 한다.
 */

export interface ValueSample {
  /** 어느 파일(작업 단위)의 자산인지 */
  packageId: string;
  /** AID 인터페이스 이름 */
  interfaceName: string;
  /** AID property 이름 */
  propertyName: string;
  /** 읽어 온 주소(NodeId 등) — 나중에 매핑을 되짚을 때 쓴다 */
  source?: string;
  /** 관측 시각(ISO). 장비가 준 시각이 있으면 그것을 쓴다 */
  observedAt: string;
  /** 숫자로 읽히면 여기, 아니면 text */
  valueNumber?: number;
  valueText?: string;
  /** 품질(OPC UA StatusCode 등). 나쁜 값도 버리지 않고 표시해 남긴다 */
  quality?: string;
}

/** 한 번 읽어 오는 쪽(프로토콜 어댑터)이 만족해야 하는 모양 */
export interface ProtocolReader {
  /** 접속 주소 */
  readonly base: string;
  /** 주소 목록을 한 번에 읽는다 */
  read(sources: readonly string[]): Promise<ReadResult[]>;
  close(): Promise<void>;
}

export interface ReadResult {
  source: string;
  value: unknown;
  /** 장비가 준 시각. 없으면 수집기가 채운다 */
  observedAt?: string;
  quality?: string;
  /** 읽지 못했을 때의 사유 */
  error?: string;
  /**
   * 🔴 **아직 값이 안 들어온 것** — 「읽다 실패했다」가 아니다.
   *
   * 우리 산출물은 Type/Template이라 **빈 값이 정상**이고(PROGRESS §4 「OPC UA 노출」 설계 5번),
   * 설비도 기동 직후에는 `BadWaitingForInitialData`처럼 「값 없음」 계열 상태를 준다.
   * 이것을 고장과 한 통에 세면 멀쩡한 설비가 「나쁜 태그 60」으로 보이고, 초보 사용자는
   * 설비가 망가졌다고 읽는다. 그래서 사유(`error`)와 **다른 칸**에 싣는다.
   *
   * 🔴 pending은 실패가 아니지만 **성공도 아니다.** 수집기는 표본을 만들지 않는다 —
   *    없는 값을 빈 문자열로 바꿔 시계열에 쌓으면 그때부터 가짜 이력이 남는다.
   */
  pending?: boolean;
}

/** 모은 값을 어디에 쌓을지 — 시계열 저장소 */
export interface SampleSink {
  append(samples: readonly ValueSample[]): Promise<void>;
}
