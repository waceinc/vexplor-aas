/**
 * Digital Product Passport metadata — IDTA 02099-1 (Part 1: Metadata, template 1.0.2), derived from EN 18223:2026.
 *
 * Every DPP carries one `DppMetadata` submodel: the passport id, the product id, the granularity, the status, the
 * economic operator and so on. The template marks seven of them with cardinality One; they are what a passport
 * cannot be published without. These rules point out blanks and malformed values while the data is being written.
 *
 * Important: not a KOSMO rule, and **only files with a DppMetadata submodel are looked at** — every other file passes
 *    through untouched, so adding these rules changes no existing result.
 * Important: passing these rules is not EU DPP compliance. They check the data points of one template; access rights,
 *    data carriers and the security part (EN 18239 · IDTA Part 4, not yet published) are out of scope.
 * Important: a submodel with kind **Template** is a blank form by design — blank values there are warnings, not errors.
 *    A missing element is an error in both, because the structure is what the template defines.
 */
import type { AssetAdministrationShell, Submodel, SubmodelElement } from '@aas/core';
import { fill, tr } from '@aas/core';
import type { LintContext, Report, Rule } from '../types.js';

const SOURCE = 'IDTA 02099-1 Digital Product Passport — Part 1 · EN 18223:2026';
const CDS = 'https://admin-shell.io/idta/cds/';

/** The seven data points with cardinality One in the template (IDTA 02099-1 §3.1). facilityId is 0..1 */
const REQUIRED = [
  'digitalProductPassportId',
  'uniqueProductIdentifier',
  'granularity',
  'dppSchemaVersion',
  'dppStatus',
  'lastUpdate',
  'economicOperatorId',
] as const;

/** GranularityEnum (§3.1) — the three values ESPR defines */
const GRANULARITY = ['Model', 'Item', 'Batch'];

/**
 * Granularity → AssetKind (Table 2: "the two values shall map").
 * Important: Batch maps to AssetKind Batch, which only exists from metamodel 3.2 — not checked until the core reads 3.2.
 */
const ASSET_KIND: Record<string, string> = { Model: 'Type', Item: 'Instance' };

/** ISO 8601 timestamp in UTC (§3.1 lastUpdate) — `Z` or a zero offset */
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]00:00)$/;

interface Located {
  element: SubmodelElement;
  index: number;
}

interface Passport {
  submodel: Submodel;
  s: number;
  template: boolean;
  elements: SubmodelElement[];
}

function semanticOf(node: { semanticId?: { keys?: { value?: string }[] } } | undefined): string {
  return node?.semanticId?.keys?.[0]?.value ?? '';
}

function termOf(semantic: string): string | undefined {
  // Version-agnostic: https://admin-shell.io/idta/cds/<term>/<n>
  return semantic.startsWith(CDS) ? /^([A-Za-z]+)\/\d+$/.exec(semantic.slice(CDS.length))?.[1] : undefined;
}

function passports(ctx: LintContext): Passport[] {
  const found: Passport[] = [];
  (ctx.environment.submodels ?? []).forEach((submodel, s) => {
    if (termOf(semanticOf(submodel)) !== 'dppMetadata' && submodel.idShort !== 'DppMetadata') return;
    found.push({
      submodel,
      s,
      template: submodel.kind === 'Template',
      elements: (submodel.submodelElements ?? []) as SubmodelElement[],
    });
  });
  return found;
}

/** Find by semanticId first (idShort may be renamed), then by idShort */
function locate(passport: Passport, term: string): Located | undefined {
  const bySemantic = passport.elements.findIndex((element) => termOf(semanticOf(element)) === term);
  const index = bySemantic >= 0 ? bySemantic : passport.elements.findIndex((element) => element.idShort === term);
  return index >= 0 ? { element: passport.elements[index]!, index } : undefined;
}

function textOf(element: SubmodelElement): string {
  const value = (element as { value?: unknown }).value;
  return typeof value === 'string' ? value.trim() : '';
}

function pointerOf(passport: Passport, index?: number): string {
  return index === undefined ? `/submodels/${passport.s}` : `/submodels/${passport.s}/submodelElements/${index}`;
}

function kosmoOf(passport: Passport, name?: string): string {
  const head = `/submodels/${passport.s}(${passport.submodel.idShort ?? passport.submodel.id})`;
  return name === undefined ? head : `${head}/${name}`;
}

export const dpp1Required: Rule = {
  id: 'DPP-1',
  layer: 'L3',
  get title() {
    return tr('제품 여권(DPP) 필수 항목 — 여권 ID · 제품 식별자 · 단위 · 스키마 판 · 상태 · 갱신 시각 · 경제 주체 ID 가 있고 비어 있지 않다');
  },
  source: `${SOURCE} §3.1 (cardinality One)`,
  check(ctx: LintContext, report: Report) {
    for (const passport of passports(ctx)) {
      for (const term of REQUIRED) {
        const found = locate(passport, term);
        if (!found) {
          report({
            severity: 'error',
            elementType: 'Submodel',
            key: term,
            pointer: pointerOf(passport),
            kosmoPath: kosmoOf(passport),
            message: fill(tr('제품 여권 필수 항목 {0} 이(가) 없습니다.'), { 0: term }),
            remedy: fill(tr('IDTA 02099-1 서식대로 Property {0} (semanticId {1}) 를 넣으십시오.'), { 0: term, 1: `${CDS}${term}/1` }),
            fixable: false,
          });
          continue;
        }
        const { element, index } = found;
        if (element.modelType !== 'Property') {
          report({
            severity: 'error',
            elementType: element.modelType,
            key: element.idShort ?? term,
            pointer: pointerOf(passport, index),
            kosmoPath: kosmoOf(passport, element.idShort ?? term),
            message: fill(tr('제품 여권 항목 {0} 은(는) Property 여야 하는데 {1} 입니다.'), { 0: term, 1: element.modelType }),
            remedy: tr('IDTA 02099-1 서식의 항목 종류(Property)로 바꾸십시오.'),
            fixable: false,
          });
          continue;
        }
        if (textOf(element) !== '') continue;
        report({
          severity: passport.template ? 'warning' : 'error',
          elementType: 'Property',
          key: element.idShort ?? term,
          pointer: `${pointerOf(passport, index)}/value`,
          kosmoPath: kosmoOf(passport, element.idShort ?? term),
          message: passport.template
            ? fill(tr('제품 여권 필수 항목 {0} 이(가) 비어 있습니다 — 서식(Template)이라 지금은 경고지만, 여권을 내기 전에 채워야 합니다.'), { 0: term })
            : fill(tr('제품 여권 필수 항목 {0} 이(가) 비어 있습니다.'), { 0: term }),
          remedy: tr('값을 채우십시오. 이 항목이 비어 있으면 여권을 낼 수 없습니다(카디널리티 One).'),
          fixable: false,
        });
      }
    }
  },
};

export const dpp2Granularity: Rule = {
  id: 'DPP-2',
  layer: 'L3',
  get title() {
    return tr('제품 여권 단위(granularity)는 Model · Item · Batch 중 하나다');
  },
  source: `${SOURCE} §3.1 GranularityEnum`,
  check(ctx: LintContext, report: Report) {
    for (const passport of passports(ctx)) {
      const found = locate(passport, 'granularity');
      if (!found || found.element.modelType !== 'Property') continue;
      const value = textOf(found.element);
      if (value === '' || GRANULARITY.includes(value)) continue;
      report({
        severity: 'error',
        elementType: 'Property',
        key: found.element.idShort ?? 'granularity',
        pointer: `${pointerOf(passport, found.index)}/value`,
        kosmoPath: kosmoOf(passport, found.element.idShort ?? 'granularity'),
        message: fill(tr('제품 여권 단위(granularity) 값이 정해진 값이 아닙니다: {0}'), { 0: value }),
        remedy: tr('Model(모델 전체) · Batch(같은 공장 · 같은 때 만든 묶음) · Item(낱개) 중 하나를 대소문자 그대로 적으십시오.'),
        fixable: false,
      });
    }
  },
};

/** Is it an ISO 8601 UTC timestamp that names a real moment (month 13 or day 40 is not one) */
function isUtcTimestamp(value: string): boolean {
  const parts = UTC_TIMESTAMP.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export const dpp3LastUpdate: Rule = {
  id: 'DPP-3',
  layer: 'L3',
  get title() {
    return tr('제품 여권 갱신 시각(lastUpdate)은 UTC 기준 ISO 8601 시각이다');
  },
  source: `${SOURCE} §3.1 lastUpdate`,
  check(ctx: LintContext, report: Report) {
    for (const passport of passports(ctx)) {
      const found = locate(passport, 'lastUpdate');
      if (!found || found.element.modelType !== 'Property') continue;
      const value = textOf(found.element);
      if (value === '' || isUtcTimestamp(value)) continue;
      report({
        severity: 'error',
        elementType: 'Property',
        key: found.element.idShort ?? 'lastUpdate',
        pointer: `${pointerOf(passport, found.index)}/value`,
        kosmoPath: kosmoOf(passport, found.element.idShort ?? 'lastUpdate'),
        message: fill(tr('제품 여권 갱신 시각(lastUpdate)이 UTC 기준 ISO 8601 시각이 아닙니다: {0}'), { 0: value }),
        remedy: tr('2025-08-22T03:12:00Z 처럼 날짜와 시각 사이에 T 를 넣고 끝에 Z(협정 세계시)를 붙이십시오. 한국 시각이면 9시간을 빼서 적습니다.'),
        fixable: false,
      });
    }
  },
};

export const dpp4ContentSpecifications: Rule = {
  id: 'DPP-4',
  layer: 'L3',
  get title() {
    return tr('제품 여권 내용 명세 목록(contentSpecificationIds)을 넣었다면 비어 있지 않은 항목이 하나 이상 있다');
  },
  source: `${SOURCE} §3.2 (contentSpecificationId 1..*)`,
  check(ctx: LintContext, report: Report) {
    for (const passport of passports(ctx)) {
      const found = locate(passport, 'contentSpecificationIds');
      if (!found) continue;
      const key = found.element.idShort ?? 'contentSpecificationIds';
      const base = { elementType: found.element.modelType, key, kosmoPath: kosmoOf(passport, key), fixable: false };
      const children = (found.element as { value?: unknown }).value;
      if (found.element.modelType !== 'SubmodelElementList' || !Array.isArray(children) || children.length === 0) {
        report({
          ...base,
          severity: 'error',
          pointer: pointerOf(passport, found.index),
          message: tr('제품 여권 내용 명세 목록(contentSpecificationIds)에 항목이 하나도 없습니다.'),
          remedy: tr('이 여권을 이루는 서브모델 서식의 semanticId 를 하나 이상 넣거나, 쓰지 않으면 목록 자체를 지우십시오(0..1).'),
        });
        continue;
      }
      (children as SubmodelElement[]).forEach((child, c) => {
        if (textOf(child) !== '') return;
        report({
          ...base,
          severity: passport.template ? 'warning' : 'error',
          pointer: `${pointerOf(passport, found.index)}/value/${c}/value`,
          message: fill(tr('제품 여권 내용 명세 목록(contentSpecificationIds)의 {0}번째 항목이 비어 있습니다.'), { 0: c + 1 }),
          remedy: tr('이 여권을 이루는 서브모델 서식의 semanticId 를 적으십시오(예: https://admin-shell.io/idta/CarbonFootprint/1/0).'),
        });
      });
    }
  },
};

function shellsOf(ctx: LintContext, submodel: Submodel): { shell: AssetAdministrationShell; a: number }[] {
  const found: { shell: AssetAdministrationShell; a: number }[] = [];
  (ctx.environment.assetAdministrationShells ?? []).forEach((shell, a) => {
    if ((shell.submodels ?? []).some((ref) => ref.keys?.some((k) => k.value === submodel.id))) found.push({ shell, a });
  });
  return found;
}

export const dpp5AssetKind: Rule = {
  id: 'DPP-5',
  layer: 'L3',
  get title() {
    return tr('제품 여권 단위(granularity)와 AAS 의 assetKind 가 짝이 맞는다 — Model 은 Type, Item 은 Instance');
  },
  source: `${SOURCE} §2.1 Table 2 · §3.1 GranularityEnum`,
  check(ctx: LintContext, report: Report) {
    for (const passport of passports(ctx)) {
      const found = locate(passport, 'granularity');
      if (!found || found.element.modelType !== 'Property') continue;
      const granularity = textOf(found.element);
      const expected = ASSET_KIND[granularity];
      if (!expected) continue;
      for (const { shell, a } of shellsOf(ctx, passport.submodel)) {
        const actual = shell.assetInformation?.assetKind;
        if (!actual || actual === expected) continue;
        report({
          severity: 'warning',
          elementType: 'AssetAdministrationShell',
          key: shell.idShort ?? shell.id,
          pointer: `/assetAdministrationShells/${a}/assetInformation/assetKind`,
          kosmoPath: `/assetAdministrationShells/${a}(${shell.idShort ?? shell.id})/assetInformation/assetKind`,
          message: fill(tr('제품 여권 단위는 {0} 인데 AAS 의 assetKind 는 {1} 입니다 — 규격은 {0} 을(를) {2} 와(과) 짝지웁니다.'), {
            0: granularity,
            1: actual,
            2: expected,
          }),
          remedy: tr('모델 단위 여권이면 assetKind 를 Type, 낱개 단위 여권이면 Instance 로 맞추거나, 여권 단위 값을 고치십시오.'),
          fixable: false,
        });
      }
    }
  },
};

export const DPP_RULES: readonly Rule[] = [dpp1Required, dpp2Granularity, dpp3LastUpdate, dpp4ContentSpecifications, dpp5AssetKind];
