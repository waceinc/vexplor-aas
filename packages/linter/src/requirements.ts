/**
 * 템플릿 요구 수준 — 서브모델의 요소마다 「필수 · 선택」을 IDTA 템플릿에서 읽는다(2026-10-13).
 *
 * 개념은 digital-twin 실운영에서 왔다 — IDTA 템플릿 전체를 카탈로그로 두고, 화면에는 「쓰는 항목」만 켜 보인다
 * (06_제품개발/2026H2_VEXPLOR_AAS_디자인전환/digital-twin_AAS_참조분석_2026-10-13.md §2-2). 코드는 옮기지 않았다.
 *
 * 🔴 근거는 **템플릿 파일의 한정자**(SMT/Cardinality — 옛 판은 Multiplicity)다. 제출용 파일(인스턴스)에는 이 한정자가
 *    남아 있지 않아(시험 파일 4종 모두 0개) 파일만 보고는 알 수 없다. 템플릿은 저장소에 동봉하지 않는다 —
 *    CC BY 4.0 표기 의무 때문에 쓰는 곳이 AAS_TEMPLATES_DIR 에 넣는다(apps/api/src/templates.ts).
 * 🔴 실제 필수 여부는 **상위까지** 본다. 선택(ZeroToOne) 묶음 안의 One 은 그 묶음을 넣을 때만 필수다.
 */
import type { Environment } from '@aas/core';

export type Cardinality = 'One' | 'ZeroToOne' | 'ZeroToMany' | 'OneToMany';

export interface ElementRequirement {
  cardinality: Cardinality;
  /** 이 요소와 그 위가 모두 필수 — 비워 두면 템플릿을 어긴다 */
  required: boolean;
}

/** 템플릿 하나에서 읽은 요구 수준 — 열쇠는 normalizeElementPath 를 거친 경로 */
export interface TemplateRequirements {
  semanticId: string;
  /** 템플릿 서브모델의 id — 같은 서브모델이 제 자신과 짝지어지지 않게 */
  sourceId?: string;
  templateIdShort?: string;
  elements: Record<string, ElementRequirement>;
}

const CARDINALITIES: readonly Cardinality[] = ['One', 'ZeroToOne', 'ZeroToMany', 'OneToMany'];
const QUALIFIER_TYPES = new Set(['SMT/Cardinality', 'Cardinality', 'Multiplicity']);

type Node = Record<string, unknown>;

/** 리스트 자식의 자리 번호를 지운다 — 템플릿의 리스트에는 견본 하나만 있다 */
export function normalizeElementPath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

export function isRequired(cardinality: Cardinality): boolean {
  return cardinality === 'One' || cardinality === 'OneToMany';
}

/** 요소의 한정자에서 개수 조건을 읽는다. 없으면 undefined(모른다) */
export function cardinalityOf(element: Node): Cardinality | undefined {
  const qualifiers = element['qualifiers'];
  if (!Array.isArray(qualifiers)) return undefined;
  for (const qualifier of qualifiers as Node[]) {
    if (!QUALIFIER_TYPES.has(String(qualifier['type'] ?? ''))) continue;
    const value = String(qualifier['value'] ?? '');
    const found = CARDINALITIES.find((c) => c.toLowerCase() === value.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

function childrenOf(node: Node): { items: Node[]; list: boolean } | undefined {
  const type = node['modelType'];
  if (type === 'SubmodelElementCollection' || type === 'SubmodelElementList') {
    const value = node['value'];
    return Array.isArray(value) ? { items: value as Node[], list: type === 'SubmodelElementList' } : undefined;
  }
  if (type === 'Entity') {
    const statements = node['statements'];
    return Array.isArray(statements) ? { items: statements as Node[], list: false } : undefined;
  }
  if (type === 'AnnotatedRelationshipElement') {
    const annotations = node['annotations'];
    return Array.isArray(annotations) ? { items: annotations as Node[], list: false } : undefined;
  }
  return undefined;
}

/**
 * 템플릿 서브모델 하나 → 경로마다 요구 수준.
 * 경로 모양은 화면의 idShortPath 와 같다(점으로 잇고, 리스트 자식은 `[]`).
 */
export function templateRequirements(submodel: Node): Record<string, ElementRequirement> {
  const out: Record<string, ElementRequirement> = {};
  const walk = (items: Node[], prefix: string, list: boolean, parentRequired: boolean): void => {
    for (const element of items) {
      const segment = list ? '[]' : String(element['idShort'] ?? '[]');
      const path = list ? `${prefix}${segment}` : prefix ? `${prefix}.${segment}` : segment;
      const cardinality = cardinalityOf(element);
      const required = cardinality !== undefined && parentRequired && isRequired(cardinality);
      if (cardinality !== undefined && out[path] === undefined) out[path] = { cardinality, required };
      const children = childrenOf(element);
      // 개수 조건이 없는 묶음은 필수로 보지 않는다 — 모르는 것을 필수라고 하지 않는다
      if (children) walk(children.items, path, children.list, required);
    }
  };
  const elements = submodel['submodelElements'];
  if (Array.isArray(elements)) walk(elements as Node[], '', false, true);
  return out;
}

function semanticIdOf(node: Node): string | undefined {
  const keys = (node['semanticId'] as { keys?: { value?: string }[] } | undefined)?.keys;
  return keys?.[0]?.value;
}

/**
 * 여러 환경에서 템플릿 서브모델(kind=Template, 개수 조건이 하나라도 있는 것)을 모은다.
 * 🔴 kind=Template 만으로는 템플릿이 아니다 — 이 사업의 제출 파일은 형식(Type) 단위라 서브모델이 모두 Template 이다
 *    (시험 파일 4종 실측). 가르는 것은 **개수 조건 한정자**다 — IDTA 템플릿에는 있고 제출 파일에는 없다.
 * 같은 semanticId 의 템플릿이 여럿이면 요소가 더 많이 적힌 쪽을 쓴다.
 */
export function collectTemplateCatalog(environments: readonly Environment[]): Map<string, TemplateRequirements> {
  const catalog = new Map<string, TemplateRequirements>();
  for (const environment of environments) {
    for (const submodel of (environment.submodels ?? []) as unknown as Node[]) {
      if (submodel['kind'] !== 'Template') continue;
      const semanticId = semanticIdOf(submodel);
      if (!semanticId) continue;
      const elements = templateRequirements(submodel);
      if (Object.keys(elements).length === 0) continue;
      const current = catalog.get(semanticId);
      if (current && Object.keys(current.elements).length >= Object.keys(elements).length) continue;
      const idShort = submodel['idShort'];
      const id = submodel['id'];
      catalog.set(semanticId, {
        semanticId,
        ...(typeof id === 'string' ? { sourceId: id } : {}),
        ...(typeof idShort === 'string' ? { templateIdShort: idShort } : {}),
        elements,
      });
    }
  }
  return catalog;
}
