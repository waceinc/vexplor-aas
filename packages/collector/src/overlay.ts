/**
 * 수집값 **읽기 전용 덧씌우기**.
 *
 * 왜 필요한가: BaSyx의 DataBridge는 OPC UA에서 읽은 값을 **Submodel에 반영**해서
 * 다른 시스템이 표준 API(`GET …/$value`)로 현재값을 볼 수 있게 한다.
 * 우리는 값 동기화 **A안**(파일이 원본)이라 수집값을 시계열에만 쌓는다 — 그래서 지금까지는
 * 외부 시스템이 우리 Part 2 API로 읽으면 **값이 비어 있는 AAS**만 보였다.
 * BaSyx를 대체한다고 말하려면 이 자리가 메워져야 한다.
 *
 * 🔴 그렇다고 모델에 되쓰지는 않는다. **응답에만** 최신 값을 얹는다 —
 *    파일은 그대로고, 이력도 그대로 남는다. A안을 깨지 않으면서 겉모습만 BaSyx와 같게 한다.
 * 🔴 이 함수는 **입력을 고치지 않는다.** 새 객체를 만들어 돌려준다(이 패키지의 계약).
 * 🔴 기본은 꺼져 있다. 요청이 `live=true`로 **명시할 때만** 켠다 —
 *    파일에 적힌 값과 현장 값이 조용히 섞이면 그게 더 나쁘다.
 */
import type { Environment, Submodel, SubmodelElement } from '@aas/core';
import type { ValueSample } from './types.js';

export type OverlayOutcome = 'applied' | 'ambiguous' | 'unmatched';

export interface OverlayNote {
  propertyName: string;
  outcome: OverlayOutcome;
  /** 덧씌운 자리 (idShortPath). 여러 곳이면 전부 */
  paths: string[];
  observedAt?: string;
  quality?: string;
}

export interface OverlayResult<T> {
  content: T;
  notes: OverlayNote[];
  /** 실제로 값을 바꾼 요소 수 */
  applied: number;
}

/** 시계열에서 (인터페이스, 이름)마다 **가장 최근** 것만 남긴다 */
export function latestByProperty(samples: readonly ValueSample[]): Map<string, ValueSample> {
  const latest = new Map<string, ValueSample>();
  for (const sample of samples) {
    const previous = latest.get(sample.propertyName);
    if (!previous || sample.observedAt > previous.observedAt) latest.set(sample.propertyName, sample);
  }
  return latest;
}

/** 값이 들어갈 수 있는 종류인가 — 담는 요소에는 얹지 않는다 */
const VALUED = new Set(['Property', 'Range', 'Blob', 'File', 'MultiLanguageProperty']);

function childrenOf(node: SubmodelElement): SubmodelElement[] {
  const record = node as unknown as Record<string, unknown>;
  if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
    return Array.isArray(record['value']) ? (record['value'] as SubmodelElement[]) : [];
  }
  if (node.modelType === 'Entity') {
    return Array.isArray(record['statements']) ? (record['statements'] as SubmodelElement[]) : [];
  }
  return [];
}

/** 수집값을 그 요소의 표현으로 — Property는 글자다(규격) */
function textOf(sample: ValueSample): string {
  if (sample.valueText !== undefined) return sample.valueText;
  if (sample.valueNumber !== undefined) return String(sample.valueNumber);
  return '';
}

interface Found {
  node: Record<string, unknown>;
  path: string;
}

/** idShort로 찾는다. AID의 property 이름이 곧 요소 idShort다(AID 규약) */
function findByIdShort(elements: readonly SubmodelElement[], name: string, prefix: string): Found[] {
  const out: Found[] = [];
  elements.forEach((element, index) => {
    const idShort = element.idShort ?? `[${index}]`;
    const path = prefix === '' ? idShort : `${prefix}.${idShort}`;
    if (element.idShort === name && VALUED.has(element.modelType)) {
      out.push({ node: element as unknown as Record<string, unknown>, path });
    }
    out.push(...findByIdShort(childrenOf(element), name, path));
  });
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyTo(elements: readonly SubmodelElement[], latest: Map<string, ValueSample>): {
  notes: OverlayNote[];
  applied: number;
} {
  const notes: OverlayNote[] = [];
  let applied = 0;

  for (const [name, sample] of latest) {
    const found = findByIdShort(elements, name, '');
    if (found.length === 0) {
      notes.push({ propertyName: name, outcome: 'unmatched', paths: [] });
      continue;
    }
    if (found.length > 1) {
      // 🔴 이름이 겹치면 얹지 않는다. 엉뚱한 요소에 현장 값이 들어가는 게 최악이다
      notes.push({
        propertyName: name,
        outcome: 'ambiguous',
        paths: found.map((entry) => entry.path),
      });
      continue;
    }
    const target = found[0]!;
    target.node['value'] = textOf(sample);
    applied += 1;
    notes.push({
      propertyName: name,
      outcome: 'applied',
      paths: [target.path],
      observedAt: sample.observedAt,
      ...(sample.quality === undefined ? {} : { quality: sample.quality }),
    });
  }
  return { notes, applied };
}

/**
 * 수집값이 **얹힐 수 있는** 요소 이름을 모은다.
 *
 * 🔴 판정 규칙(`VALUED`)을 덧씌우기와 **같은 자리에 둔다.** 다른 파일에서 따로 세면
 *    규칙이 갈라진다 — 실측: AID 안의 태그 기술자(SMC)까지 세어 엉뚱한 이름을 충돌로 봤다.
 *    AID의 `MotorSpeed`는 SubmodelElementCollection이라 값이 얹히지 않으므로 충돌이 아니다.
 *
 * @param exceptSubmodelId 이 서브모델은 뺀다(자기 안의 중복은 따로 다루는 쪽이 있을 때)
 */
export function valuedNames(
  environment: Environment,
  exceptSubmodelId?: string,
): string[] {
  const names: string[] = [];
  const walk = (elements: readonly SubmodelElement[]): void => {
    for (const element of elements) {
      if (element.idShort !== undefined && VALUED.has(element.modelType)) names.push(element.idShort);
      walk(childrenOf(element));
    }
  };
  for (const submodel of environment.submodels ?? []) {
    if (exceptSubmodelId !== undefined && submodel.id === exceptSubmodelId) continue;
    walk(submodel.submodelElements ?? []);
  }
  return names;
}

/** 서브모델 하나에 덧씌운다 (사본을 돌려준다) */
export function overlaySubmodel(
  submodel: Submodel,
  samples: readonly ValueSample[],
): OverlayResult<Submodel> {
  const copy = clone(submodel);
  const { notes, applied } = applyTo(copy.submodelElements ?? [], latestByProperty(samples));
  return { content: copy, notes, applied };
}

/**
 * Environment 전체에 덧씌운다 (사본을 돌려준다).
 *
 * 🔴 중복 판정은 **환경 전체 기준**이다. 서브모델마다 따로 세면 서로 다른 서브모델에 있는
 *    같은 이름이 각각 "그 안에서 유일"로 판정돼 **둘 다 덮인다** — 실측 버그였다.
 *    실제 모습: 명판의 `ManufacturerName`과, 수집용으로 새로 세운 같은 이름의 항목.
 *    그러면 현장 값이 **명판을 덮어써서** 제조사명이 측정값으로 바뀐다.
 *    「엉뚱한 요소에 현장 값이 들어가는 게 최악」이라는 규칙이 서브모델 경계에서 새고 있었다.
 */
export function overlayEnvironment(
  environment: Environment,
  samples: readonly ValueSample[],
): OverlayResult<Environment> {
  const copy = clone(environment);
  const latest = latestByProperty(samples);
  const notes: OverlayNote[] = [];
  let applied = 0;

  for (const [name, sample] of latest) {
    // 어느 서브모델에 있든 다 모은다. 경로에 서브모델 이름을 붙여야 사람이 찾아갈 수 있다
    const found: Found[] = [];
    for (const submodel of copy.submodels ?? []) {
      const label = submodel.idShort ?? submodel.id;
      for (const entry of findByIdShort(submodel.submodelElements ?? [], name, '')) {
        found.push({ node: entry.node, path: `${label}.${entry.path}` });
      }
    }

    if (found.length === 0) {
      notes.push({ propertyName: name, outcome: 'unmatched', paths: [] });
      continue;
    }
    if (found.length > 1) {
      notes.push({
        propertyName: name,
        outcome: 'ambiguous',
        paths: found.map((entry) => entry.path),
      });
      continue;
    }
    const target = found[0]!;
    target.node['value'] = textOf(sample);
    applied += 1;
    notes.push({
      propertyName: name,
      outcome: 'applied',
      paths: [target.path],
      observedAt: sample.observedAt,
      ...(sample.quality === undefined ? {} : { quality: sample.quality }),
    });
  }

  return { content: copy, notes, applied };
}
