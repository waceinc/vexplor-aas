/**
 * Reference bundle — analysis of **data linkage** among the equipment grouped into one process.
 *
 * A bundle is "equipment deliverables grouped by process" (레퍼런스번들_추진방안 §2).
 * The grouping itself is already done by the hierarchy (HierarchicalStructures). What a bundle additionally
 * requires is **whether the inputs for computing process KPIs actually exist in the equipment** — OEE needs the
 * operating states of several machines, energy intensity needs the cumulative energy of several machines.
 *
 * So here we collect the Properties of each machine's operational data (OperationalData) and
 * **group them by semanticId.** semanticId, not name (idShort) — names are chosen by people,
 * while a semanticId points to a meaning.
 *
 * Important: but trusting semanticId alone is wrong (measured 2026-09-30 on 30 project reference models).
 *  - A single ECLASS IRDI (`0173-1#02-ABC132#004`) is **reused for different concepts** such as
 *    MachineState, AlarmCode, JudgmentResult → reports "same semanticId, different names"
 *  - The same MachineState splits between a KOSMO IRI and an ECLASS IRDI depending on the file
 *    → reports "same name, different semanticIds"
 * The tool does not decide which is right. Linkage mappings are written as **path + semanticId pairs**.
 *
 * Important: synonyms are not guessed (e.g. MachineState ≈ RobotState). A wrong guess makes
 *    the KPI silently wrong. The mapping table leaves blank cells for a person to fill.
 */
import { fill, tr, type Environment, type SubmodelElement } from '@aas/core';
import { csvCell } from './csv.js';

/** Submodel scanned by default — the operational data submodel that all 30 models have */
export const LINKAGE_SUBMODELS = ['OperationalData'] as const;

export interface BundleMemberInput {
  /** Name as written in the hierarchy */
  name: string;
  globalAssetId: string;
  /** Equipment file. If absent (planned), it is left out of the linkage analysis */
  environment?: Environment;
}

/** One slot within a machine that serves as a linkage input */
export interface LinkPoint {
  member: string;
  /** Path from the submodel idShort — `OperationalData/ProcessMonitoring/MachineState` */
  path: string;
  idShort: string;
  semanticId: string;
  valueType?: string;
  /** Unit found in the ConceptDescription */
  unit?: string;
}

/** Linkage item grouped by one semanticId */
export interface LinkageItem {
  semanticId: string;
  /** Representative name — the most frequently used idShort */
  label: string;
  /** Names that use this semanticId (including the representative) */
  names: string[];
  /** Definition name from the ConceptDescription, Korean (English if absent) */
  preferredName?: string;
  unit?: string;
  /** Equipment name → slots within that equipment */
  points: Record<string, LinkPoint[]>;
  /** How many machines have it */
  coverage: number;
}

export type LinkageFindingKind = 'shared-semantic' | 'split-semantic';

export interface LinkageFinding {
  kind: LinkageFindingKind;
  severity: 'warning' | 'info';
  message: string;
  /** Related semanticIds */
  semanticIds: string[];
  names: string[];
}

export interface BundleLinkage {
  /** Equipment included in the analysis (those with a file) */
  members: string[];
  /** Equipment left out because it has no file */
  missing: string[];
  /** Sorted by coverage, descending */
  items: LinkageItem[];
  findings: LinkageFinding[];
}

const firstKey = (reference: unknown): string | undefined => {
  const value = (reference as { keys?: { value?: unknown }[] } | undefined)?.keys?.[0]?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** CD id → (name, unit). Read from the IEC 61360 data specification */
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

/** Linkage inputs of one machine — all Properties within the specified submodels */
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
 * Bundle linkage analysis.
 * If the same machine appears twice in the hierarchy (same machine in two processes), it is counted once.
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
  // ① Same semanticId, different names — risk of treating different meanings as the same
  for (const item of items) {
    if (item.names.length < 2) continue;
    findings.push({
      kind: 'shared-semantic',
      severity: 'warning',
      message:
        fill(tr('semanticId 하나를 서로 다른 이름 {0}개가 씁니다: {1}. 같은 개념인지 확인하십시오 — 연계 매핑은 semanticId만으로 잡지 말고 경로를 함께 적습니다.'), {
          0: item.names.length,
          1: item.names.join(', '),
        }),
      semanticIds: [item.semanticId],
      names: item.names,
    });
  }
  // ② Same name, different semanticIds — risk of treating the same thing as different
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
        fill(tr('「{0}」 — 이름은 같은데 semanticId가 {1}종입니다. KPI를 모을 때 하나로 볼지 매핑표에서 정하십시오.'), { 0: name, 1: ids.size }),
      semanticIds: [...ids],
      names: [name],
    });
  }

  return { members, missing, items, findings };
}

/** One CSV cell — quotes commas, double quotes, and line breaks */
const cell = (value: string): string => csvCell(value);

/**
 * Linkage definition table (bundle 04_데이터연계정의). Adds a BOM so it opens directly in Excel.
 * The "linkage key" and "KPI usage" columns are **for a person to fill** — the tool does not guess.
 */
export function linkageCsv(linkage: BundleLinkage): string {
  const header = [tr('연계 키(사람이 채움)'), tr('KPI 용도(사람이 채움)'), tr('대표 이름'), 'semanticId', tr('정의 이름'), tr('단위'), tr('보유 설비 수'), tr('설비'), tr('경로'), 'valueType'];
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
