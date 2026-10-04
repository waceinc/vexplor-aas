/**
 * Environment 순회기.
 *
 * 린터(M5)와 리포트가 공통으로 쓴다. KOSMO Validator의 에러 로그가
 *   @ /submodels/3(OperationalData)/submodelElements/0/value/0
 * 형태이므로(린터 명세 §7), 동일한 JSON Pointer 경로를 그대로 만들어 낸다.
 */
import type { ConceptDescription } from './types/concept.js';
import type { Environment } from './types/environment.js';
import type { AssetAdministrationShell } from './types/shell.js';
import type { Submodel, SubmodelElement } from './types/submodel.js';

/** semanticId를 가질 수 있는 모든 요소 — KOSMO-SME-3의 검사 대상 범위 */
export type SemanticNode = Submodel | SubmodelElement;

export interface VisitedNode {
  /** 방문한 노드 */
  node: SubmodelElement;
  /** RFC 6901 JSON Pointer (Environment 루트 기준) */
  pointer: string;
  /** KOSMO 리포트용 경로 — 인덱스 뒤에 idShort를 괄호로 붙인다 */
  kosmoPath: string;
  /** 루트 Submodel */
  submodel: Submodel;
  /** 직계 부모. 최상위 SubmodelElement면 undefined */
  parent?: SubmodelElement;
  /** idShort를 '.'으로 이은 경로. SML 자식처럼 idShort가 없으면 인덱스를 쓴다 */
  idShortPath: string;
  /** 루트로부터의 깊이(최상위 SubmodelElement = 0) */
  depth: number;
}

/** JSON Pointer 세그먼트 이스케이프 (RFC 6901) */
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * 요소가 자식을 담는 필드명을 돌려준다.
 * SMC/SML은 value, Entity는 statements, AnnotatedRelationshipElement는 annotations.
 */
function childrenOf(node: SubmodelElement): { field: string; items: SubmodelElement[] } | undefined {
  switch (node.modelType) {
    case 'SubmodelElementCollection':
    case 'SubmodelElementList':
      return node.value ? { field: 'value', items: node.value } : undefined;
    case 'Entity':
      return node.statements ? { field: 'statements', items: node.statements } : undefined;
    case 'AnnotatedRelationshipElement':
      return node.annotations ? { field: 'annotations', items: node.annotations } : undefined;
    default:
      return undefined;
  }
}

/** 하나의 Submodel 아래 모든 SubmodelElement를 깊이 우선으로 방문한다 */
export function walkSubmodel(
  submodel: Submodel,
  submodelIndex: number,
  visit: (v: VisitedNode) => void,
): void {
  const rootPointer = `/submodels/${submodelIndex}/submodelElements`;
  const rootKosmo = `/submodels/${submodelIndex}(${submodel.idShort ?? '?'})/submodelElements`;

  const recurse = (
    items: SubmodelElement[],
    pointer: string,
    kosmoPath: string,
    idShortPath: string,
    parent: SubmodelElement | undefined,
    depth: number,
  ): void => {
    items.forEach((node, i) => {
      const p = `${pointer}/${i}`;
      const label = node.idShort ?? String(i);
      const k = `${kosmoPath}/${i}${node.idShort ? `(${node.idShort})` : ''}`;
      const isp = idShortPath ? `${idShortPath}.${label}` : label;
      visit({ node, pointer: p, kosmoPath: k, submodel, parent, idShortPath: isp, depth });

      const children = childrenOf(node);
      if (children) {
        recurse(children.items, `${p}/${children.field}`, `${k}/${children.field}`, isp, node, depth + 1);
      }
    });
  };

  recurse(submodel.submodelElements ?? [], rootPointer, rootKosmo, '', undefined, 0);
}

/** Environment 전체의 SubmodelElement를 방문한다 */
export function walkEnvironment(env: Environment, visit: (v: VisitedNode) => void): void {
  (env.submodels ?? []).forEach((sm, i) => walkSubmodel(sm, i, visit));
}

/** 순회 결과를 배열로 모은다 (린터는 전수 수집 후 일괄 보고 — 명세 §6-4) */
export function collectElements(env: Environment): VisitedNode[] {
  const out: VisitedNode[] = [];
  walkEnvironment(env, (v) => out.push(v));
  return out;
}

export interface IdentifiableIndex {
  shells: Map<string, AssetAdministrationShell>;
  submodels: Map<string, Submodel>;
  conceptDescriptions: Map<string, ConceptDescription>;
}

/** id → 객체 색인. KOSMO-SME-3(CD 매핑 존재 여부) 검사에 쓴다 */
export function indexIdentifiables(env: Environment): IdentifiableIndex {
  return {
    shells: new Map((env.assetAdministrationShells ?? []).map((s) => [s.id, s])),
    submodels: new Map((env.submodels ?? []).map((s) => [s.id, s])),
    conceptDescriptions: new Map((env.conceptDescriptions ?? []).map((c) => [c.id, c])),
  };
}
