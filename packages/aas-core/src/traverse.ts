/**
 * Environment traverser.
 *
 * Shared by the linter (M5) and reports. The KOSMO Validator's error log has the form
 *   @ /submodels/3(OperationalData)/submodelElements/0/value/0
 * (linter spec §7), so we produce the same JSON Pointer paths verbatim.
 */
import type { ConceptDescription } from './types/concept.js';
import type { Environment } from './types/environment.js';
import type { AssetAdministrationShell } from './types/shell.js';
import type { Submodel, SubmodelElement } from './types/submodel.js';

/** Every element that can have a semanticId — the scope checked by KOSMO-SME-3 */
export type SemanticNode = Submodel | SubmodelElement;

export interface VisitedNode {
  /** Visited node */
  node: SubmodelElement;
  /** RFC 6901 JSON Pointer (relative to the Environment root) */
  pointer: string;
  /** Path for KOSMO reports — idShort appended in parentheses after the index */
  kosmoPath: string;
  /** Root Submodel */
  submodel: Submodel;
  /** Direct parent. undefined for a top-level SubmodelElement */
  parent?: SubmodelElement;
  /** Path of idShorts joined by '.'. Uses the index when there is no idShort, as with SML children */
  idShortPath: string;
  /** Depth from the root (top-level SubmodelElement = 0) */
  depth: number;
}

/** Escape a JSON Pointer segment (RFC 6901) */
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Returns the name of the field in which an element holds its children.
 * value for SMC/SML, statements for Entity, annotations for AnnotatedRelationshipElement.
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

/** Visit every SubmodelElement under one Submodel, depth-first */
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

/** Visit every SubmodelElement in the whole Environment */
export function walkEnvironment(env: Environment, visit: (v: VisitedNode) => void): void {
  (env.submodels ?? []).forEach((sm, i) => walkSubmodel(sm, i, visit));
}

/** Collect traversal results into an array (the linter collects everything, then reports in one batch — spec §6-4) */
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

/** id → object index. Used by the KOSMO-SME-3 check (whether a CD mapping exists) */
export function indexIdentifiables(env: Environment): IdentifiableIndex {
  return {
    shells: new Map((env.assetAdministrationShells ?? []).map((s) => [s.id, s])),
    submodels: new Map((env.submodels ?? []).map((s) => [s.id, s])),
    conceptDescriptions: new Map((env.conceptDescriptions ?? []).map((c) => [c.id, c])),
  };
}
