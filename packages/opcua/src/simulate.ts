/**
 * 가상 PLC의 태그 설계 — **아무 설비 AASX나** 읽어 그 설비의 운전 데이터 이름대로 태그를 만든다.
 *
 * 예전 가상 PLC는 롤포밍기 태그 7종이 박혀 있어 레퍼런스 번들 RB01 말고는 시연할 수 없었다
 * (추진방안 §3.1). 태그 이름을 모델의 idShort와 같게 두면 「수집 연결 만들기」가 훑어 온
 * 태그를 그대로 모델 자리에 잇는다 — 새 화면 없이 기존 흐름으로 어느 설비든 시연이 된다.
 *
 * 값은 **모델에 적힌 예시값을 중심으로** 흔든다. 규칙은 이름에서 읽는 최소한만 둔다.
 *  - 가동상태(…State)      RUNNING ↔ ALARM (알람 창에서만 ALARM).
 *    …Status는 건드리지 않는다 — RollWearStatus(롤 마모 상태)가 RUNNING으로 나왔다(2026-09-30 시연 점검)
 *  - 알람(Alarm…) 불리언    40초마다 5초 켜짐 · 코드(…Code)는 그때만 E-코드
 *  - 판정(Judgment/Result)  OK, 열 번에 한 번 NG
 *  - 누적(Cumulative/Count/Hours/Energy)  시간에 따라 늘어난다. 불량 수(NG·Defect·Reject…Count)는 열 사이클에 한 번
 *  - 그 밖의 수         예시값 ±3% 사인파 (예시값이 없으면 50 중심)
 *  - 그 밖의 글자       예시값 그대로
 *
 * 🔴 **시뮬레이션이다.** 이 값을 실측처럼 쓰면 안 된다(추진방안 §3.4-3). 서버 이름에도 적는다.
 */

/** 설계에 필요한 만큼만 — @aas/core 타입에 기대지 않는다 */
interface ElementLike {
  modelType?: string;
  idShort?: string;
  valueType?: string;
  value?: unknown;
  statements?: unknown;
}
interface EnvironmentLike {
  assetAdministrationShells?: { idShort?: string }[];
  submodels?: { idShort?: string; submodelElements?: ElementLike[] }[];
}

export type SimDataType = 'Double' | 'Int32' | 'Boolean' | 'String';

export interface SimTag {
  /** OPC UA 브라우즈 이름 = 모델의 idShort */
  name: string;
  /** 설비 안에서 고유한 NodeId 문자열 — `s=` 뒤에 붙는다 */
  nodeId: string;
  /** 서브모델부터의 경로(사람이 대조하는 용도) */
  path: string;
  dataType: SimDataType;
  /** 경과 초 → 값 */
  valueAt: (seconds: number) => number | boolean | string;
}

export interface SimMachine {
  /** OPC UA 오브젝트 이름 = AAS idShort */
  name: string;
  tags: SimTag[];
}

const ALARM_PERIOD = 40;
const ALARM_WINDOW = 5;
const inAlarm = (t: number): boolean => t % ALARM_PERIOD < ALARM_WINDOW;

function dataTypeOf(valueType: string | undefined): SimDataType {
  const vt = (valueType ?? '').replace(/^xs:/, '');
  if (vt === 'boolean') return 'Boolean';
  if (['double', 'float', 'decimal'].includes(vt)) return 'Double';
  if (/int|long|short|byte/i.test(vt)) return 'Int32';
  return 'String';
}

/** 태그 하나의 값 규칙 */
export function valueRule(name: string, dataType: SimDataType, example: unknown): (t: number) => number | boolean | string {
  const base = Number(example);
  const hasBase = example !== undefined && example !== '' && Number.isFinite(base);
  const lower = name.toLowerCase();

  if (dataType === 'Boolean') {
    if (/alarm|fault|error|warn/.test(lower)) return (t) => inAlarm(t);
    return () => example === 'false' ? false : true;
  }
  if (dataType === 'String') {
    if (/state$/.test(lower)) return (t) => (inAlarm(t) ? 'ALARM' : 'RUNNING');
    if (/code$/.test(lower)) return (t) => (inAlarm(t) ? 'E102' : 'E000');
    if (/judg|result/.test(lower)) return (t) => (Math.floor(t / 3) % 10 === 9 ? 'NG' : 'OK');
    const text = typeof example === 'string' && example !== '' ? example : 'SIM';
    return () => text;
  }
  // 수
  const round = (v: number): number => (dataType === 'Int32' ? Math.round(v) : Number(v.toFixed(2)));
  // 불량 수는 판정 NG 주기(3초 사이클 열 번에 한 번)에 맞춰 는다 — 생산 수와 같은 속도로 늘면
  // 양품률이 0%로 계산된다(2026-09-30 Use-Case KPI 계산에서 발견)
  if (/(^|[a-z])(ng|defect|reject|fail)[a-z]*count/.test(lower) || /^(ng|defect|reject)/.test(lower)) {
    const start = hasBase ? base : 0;
    return (t) => round(start + Math.floor(t / 30));
  }
  if (/count/.test(lower)) {
    const start = hasBase ? base : 0;
    return (t) => round(start + Math.floor(t / 3));
  }
  if (/cumulative|total|hours|energy/.test(lower)) {
    const start = hasBase ? base : 1000;
    return (t) => round(start + t * 0.01);
  }
  const center = hasBase ? base : 50;
  const swing = Math.abs(center) * 0.03 || 1;
  return (t) => round(center + Math.sin(t / 6) * swing);
}

/** 기본으로 태그를 만드는 서브모델 — 번들 연계 분석과 같은 것 */
export const SIMULATED_SUBMODELS = ['OperationalData'];

export function simulationPlan(environment: EnvironmentLike, submodels: readonly string[] = SIMULATED_SUBMODELS): SimMachine {
  const name = environment.assetAdministrationShells?.[0]?.idShort ?? 'Machine';
  const tags: SimTag[] = [];
  const used = new Map<string, number>();

  const walk = (elements: ElementLike[] | undefined, prefix: string): void => {
    for (const element of elements ?? []) {
      const idShort = element.idShort ?? '';
      const path = idShort ? `${prefix}/${idShort}` : prefix;
      if (element.modelType === 'Property' && idShort) {
        const dataType = dataTypeOf(element.valueType);
        // 같은 이름이 설비 안에 둘이면 NodeId에 번호를 붙인다. 브라우즈 이름은 그대로 둔다
        const seen = used.get(idShort) ?? 0;
        used.set(idShort, seen + 1);
        tags.push({
          name: idShort,
          nodeId: `${name}.${idShort}${seen > 0 ? `_${seen + 1}` : ''}`,
          path,
          dataType,
          valueAt: valueRule(idShort, dataType, element.value),
        });
      }
      if (Array.isArray(element.value)) walk(element.value as ElementLike[], path);
      if (Array.isArray(element.statements)) walk(element.statements as ElementLike[], path);
    }
  };
  for (const submodel of environment.submodels ?? []) {
    if (submodels.includes(submodel.idShort ?? '')) walk(submodel.submodelElements, submodel.idShort ?? '');
  }
  return { name, tags };
}
