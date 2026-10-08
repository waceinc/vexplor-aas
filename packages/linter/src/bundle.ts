/**
 * 레퍼런스 번들 — 공정 하나에 묶인 설비들 사이의 **데이터 연계** 분석.
 *
 * 번들은 「장비 산출물을 공정 단위로 묶은 것」이다(레퍼런스번들_추진방안 §2).
 * 묶는 것 자체는 계층(HierarchicalStructures)이 이미 한다. 번들이 더 요구하는 것은
 * **공정 KPI를 계산할 재료가 장비들에 실제로 있는가**다 — OEE는 여러 장비의 가동상태를,
 * 에너지 원단위는 여러 장비의 누적전력량을 모아야 나온다.
 *
 * 그래서 여기서는 설비마다 운전 데이터(OperationalData)의 Property를 모아
 * **semanticId로 묶는다.** 이름(idShort)이 아니라 semanticId다 — 이름은 사람이 짓고
 * semanticId는 뜻을 가리키기 때문이다.
 *
 * 🔴 그런데 semanticId만 믿으면 틀린다 (2026-09-30 사업 참조모델 30종 실측).
 *  - ECLASS IRDI 하나(`0173-1#02-ABC132#004`)가 MachineState·AlarmCode·JudgmentResult처럼
 *    **서로 다른 개념에 재사용**된다 → 「같은 semanticId, 다른 이름」을 알린다
 *  - 같은 MachineState가 파일에 따라 KOSMO IRI · ECLASS IRDI로 갈린다
 *    → 「같은 이름, 다른 semanticId」를 알린다
 * 어느 쪽이 맞는지는 도구가 정하지 않는다. 연계 매핑은 **경로 + semanticId 쌍**으로 적게 한다.
 *
 * 🔴 동의어를 추측하지 않는다(MachineState ≈ RobotState 같은 것). 추측이 틀리면
 *    KPI가 조용히 틀린다. 사람이 채우도록 매핑표에 빈 칸을 준다.
 */
import type { Environment, SubmodelElement } from '@aas/core';
import { csvCell } from './csv.js';

/** 기본으로 훑는 서브모델 — 30종 전부가 가진 운전 데이터 서브모델 */
export const LINKAGE_SUBMODELS = ['OperationalData'] as const;

export interface BundleMemberInput {
  /** 계층에 적힌 이름 */
  name: string;
  globalAssetId: string;
  /** 설비 파일. 없으면(예정) 연계 분석에서 빠진다 */
  environment?: Environment;
}

/** 한 설비 안에서 연계 재료가 되는 자리 하나 */
export interface LinkPoint {
  member: string;
  /** 서브모델 idShort부터의 경로 — `OperationalData/ProcessMonitoring/MachineState` */
  path: string;
  idShort: string;
  semanticId: string;
  valueType?: string;
  /** ConceptDescription에서 찾은 단위 */
  unit?: string;
}

/** semanticId 하나로 묶인 연계 항목 */
export interface LinkageItem {
  semanticId: string;
  /** 대표 이름 — 가장 많이 쓰인 idShort */
  label: string;
  /** 그 semanticId를 쓰는 이름들(대표 포함) */
  names: string[];
  /** ConceptDescription의 우리말(없으면 영어) 정의 이름 */
  preferredName?: string;
  unit?: string;
  /** 설비 이름 → 그 설비 안의 자리들 */
  points: Record<string, LinkPoint[]>;
  /** 몇 개 설비가 가졌나 */
  coverage: number;
}

export type LinkageFindingKind = 'shared-semantic' | 'split-semantic';

export interface LinkageFinding {
  kind: LinkageFindingKind;
  severity: 'warning' | 'info';
  message: string;
  /** 관련 semanticId들 */
  semanticIds: string[];
  names: string[];
}

export interface BundleLinkage {
  /** 분석에 들어간 설비(파일이 있는 것) */
  members: string[];
  /** 파일이 없어 빠진 설비 */
  missing: string[];
  /** coverage 내림차순 */
  items: LinkageItem[];
  findings: LinkageFinding[];
}

const firstKey = (reference: unknown): string | undefined => {
  const value = (reference as { keys?: { value?: unknown }[] } | undefined)?.keys?.[0]?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** CD id → (이름, 단위). IEC 61360 데이터 명세에서 읽는다 */
function conceptIndex(environment: Environment): Map<string, { name?: string; unit?: string }> {
  const index = new Map<string, { name?: string; unit?: string }>();
  for (const cd of environment.conceptDescriptions ?? []) {
    const spec = (cd as { embeddedDataSpecifications?: { dataSpecificationContent?: Record<string, unknown> }[] })
      .embeddedDataSpecifications?.[0]?.dataSpecificationContent;
    const names = (spec?.['preferredName'] ?? []) as { language?: string; text?: string }[];
    const name = names.find((n) => n.language?.startsWith('ko'))?.text ?? names[0]?.text;
    const unit = typeof spec?.['unit'] === 'string' && spec['unit'] !== '' ? (spec['unit'] as string) : undefined;
    index.set(cd.id, { ...(name ? { name } : {}), ...(unit ? { unit } : {}) });
  }
  return index;
}

/** 설비 하나의 연계 재료 — 지정 서브모델 안 Property 전부 */
export function linkPointsOf(
  member: string,
  environment: Environment,
  submodels: readonly string[] = LINKAGE_SUBMODELS,
): LinkPoint[] {
  const concepts = conceptIndex(environment);
  const out: LinkPoint[] = [];
  const walk = (elements: readonly SubmodelElement[] | undefined, prefix: string): void => {
    for (const element of elements ?? []) {
      const idShort = element.idShort ?? '';
      const path = idShort ? `${prefix}/${idShort}` : prefix;
      if (element.modelType === 'Property' || element.modelType === 'Range') {
        const semanticId = firstKey(element.semanticId);
        if (semanticId) {
          const unit = concepts.get(semanticId)?.unit;
          const valueType = (element as { valueType?: string }).valueType;
          out.push({
            member,
            path,
            idShort,
            semanticId,
            ...(valueType ? { valueType } : {}),
            ...(unit ? { unit } : {}),
          });
        }
      }
      const holder = element as { value?: unknown; statements?: unknown };
      if (Array.isArray(holder.value)) walk(holder.value as SubmodelElement[], path);
      if (Array.isArray(holder.statements)) walk(holder.statements as SubmodelElement[], path);
    }
  };
  for (const submodel of environment.submodels ?? []) {
    if (!submodels.includes(submodel.idShort ?? '')) continue;
    walk(submodel.submodelElements, submodel.idShort ?? '');
  }
  return out;
}

/**
 * 번들 연계 분석.
 * 같은 설비가 계층에 두 번 나와도(두 공정에 같은 설비) 한 번만 센다.
 */
export function bundleLinkage(
  inputs: readonly BundleMemberInput[],
  submodels: readonly string[] = LINKAGE_SUBMODELS,
): BundleLinkage {
  const members: string[] = [];
  const missing: string[] = [];
  const bySemantic = new Map<string, LinkPoint[]>();
  const conceptInfo = new Map<string, { name?: string; unit?: string }>();
  const seen = new Set<string>();

  for (const input of inputs) {
    const key = input.globalAssetId || input.name;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!input.environment) {
      missing.push(input.name);
      continue;
    }
    members.push(input.name);
    for (const [id, info] of conceptIndex(input.environment)) {
      if (!conceptInfo.has(id)) conceptInfo.set(id, info);
    }
    for (const point of linkPointsOf(input.name, input.environment, submodels)) {
      const list = bySemantic.get(point.semanticId) ?? [];
      list.push(point);
      bySemantic.set(point.semanticId, list);
    }
  }

  const items: LinkageItem[] = [];
  for (const [semanticId, points] of bySemantic) {
    const nameCount = new Map<string, number>();
    for (const point of points) nameCount.set(point.idShort, (nameCount.get(point.idShort) ?? 0) + 1);
    const names = [...nameCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
    const grouped: Record<string, LinkPoint[]> = {};
    for (const point of points) (grouped[point.member] ??= []).push(point);
    const info = conceptInfo.get(semanticId);
    const unit = info?.unit ?? points.find((p) => p.unit)?.unit;
    items.push({
      semanticId,
      label: names[0]!,
      names,
      ...(info?.name ? { preferredName: info.name } : {}),
      ...(unit ? { unit } : {}),
      points: grouped,
      coverage: Object.keys(grouped).length,
    });
  }
  items.sort((a, b) => b.coverage - a.coverage || a.label.localeCompare(b.label));

  const findings: LinkageFinding[] = [];
  // ① 같은 semanticId, 다른 이름 — 뜻이 다른 것을 같은 것으로 볼 위험
  for (const item of items) {
    if (item.names.length < 2) continue;
    findings.push({
      kind: 'shared-semantic',
      severity: 'warning',
      message:
        `semanticId 하나를 서로 다른 이름 ${item.names.length}개가 씁니다: ${item.names.join(', ')}. ` +
        '같은 개념인지 확인하십시오 — 연계 매핑은 semanticId만으로 잡지 말고 경로를 함께 적습니다.',
      semanticIds: [item.semanticId],
      names: item.names,
    });
  }
  // ② 같은 이름, 다른 semanticId — 같은 것을 다른 것으로 볼 위험
  const byName = new Map<string, Set<string>>();
  for (const item of items) {
    for (const name of item.names) {
      const set = byName.get(name) ?? new Set<string>();
      set.add(item.semanticId);
      byName.set(name, set);
    }
  }
  for (const [name, ids] of byName) {
    if (ids.size < 2) continue;
    findings.push({
      kind: 'split-semantic',
      severity: 'info',
      message:
        `「${name}」 — 이름은 같은데 semanticId가 ${ids.size}종입니다. ` +
        'KPI를 모을 때 하나로 볼지 매핑표에서 정하십시오.',
      semanticIds: [...ids],
      names: [name],
    });
  }

  return { members, missing, items, findings };
}

/** CSV 한 칸 — 쉼표·따옴표·줄바꿈을 감싼다 */
const cell = (value: string): string => csvCell(value);

/**
 * 연계 정의표(번들 04_데이터연계정의). 엑셀에서 바로 열리게 BOM을 붙인다.
 * 「연계 키」「KPI 용도」는 **사람이 채울 칸**이다 — 도구는 추측하지 않는다.
 */
export function linkageCsv(linkage: BundleLinkage): string {
  const header = ['연계 키(사람이 채움)', 'KPI 용도(사람이 채움)', '대표 이름', 'semanticId', '정의 이름', '단위', '보유 설비 수', '설비', '경로', 'valueType'];
  const rows: string[] = [header.map(cell).join(',')];
  for (const item of linkage.items) {
    for (const member of linkage.members) {
      for (const point of item.points[member] ?? []) {
        rows.push(
          [
            '',
            '',
            item.label,
            item.semanticId,
            item.preferredName ?? '',
            item.unit ?? '',
            String(item.coverage),
            member,
            point.path,
            point.valueType ?? '',
          ]
            .map(cell)
            .join(','),
        );
      }
    }
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}
