/**
 * Template requirement level — reads "required · optional" for each submodel element from the IDTA template (2026-10-13).
 *
 * The concept comes from digital-twin production use — keep every IDTA template as a catalog and show only the
 * "used items" on screen (06_제품개발/2026H2_VEXPLOR_AAS_디자인전환/digital-twin_AAS_참조분석_2026-10-13.md §2-2).
 * No code was copied.
 *
 * Important: the basis is **the qualifiers in the template file** (SMT/Cardinality — Multiplicity in older versions). Submission files
 *    (instances) do not retain these qualifiers (0 in all 4 test files), so the file alone cannot tell. Templates are not bundled
 *    in the repository — because of the CC BY 4.0 attribution obligation, the consumer puts them in AAS_TEMPLATES_DIR
 *    (apps/api/src/templates.ts).
 * Important: whether something is actually required is checked **up through its ancestors**. A One inside an optional (ZeroToOne)
 *    group is required only when that group is included.
 */
import type { Environment } from '@aas/core';

export type Cardinality = 'One' | 'ZeroToOne' | 'ZeroToMany' | 'OneToMany';

export interface ElementRequirement {
  cardinality: Cardinality;
  /** This element and everything above it are required — leaving it empty violates the template */
  required: boolean;
}

/** Requirement levels read from one template — keys are paths passed through normalizeElementPath */
export interface TemplateRequirements {
  semanticId: string;
  /** id of the template submodel — so a submodel is not paired with itself */
  sourceId?: string;
  templateIdShort?: string;
  elements: Record<string, ElementRequirement>;
}

const CARDINALITIES: readonly Cardinality[] = ['One', 'ZeroToOne', 'ZeroToMany', 'OneToMany'];
const QUALIFIER_TYPES = new Set(['SMT/Cardinality', 'Cardinality', 'Multiplicity']);

type Node = Record<string, unknown>;

/** Strip list-child position numbers — a template's list holds only one sample */
export function normalizeElementPath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

export function isRequired(cardinality: Cardinality): boolean {
  return cardinality === 'One' || cardinality === 'OneToMany';
}

/** Read the cardinality condition from the element's qualifiers. undefined (unknown) if absent */
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
 * One template submodel → requirement level per path.
 * Paths have the same shape as the UI's idShortPath (joined with dots; list children are `[]`).
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
      // Groups without a cardinality condition are not treated as required — we don't call something required when we don't know
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
 * Collect template submodels (kind=Template with at least one cardinality condition) from multiple environments.
 * Important: kind=Template alone does not make a template — this project's submission files are per Type, so all their
 *    submodels are Template (measured on 4 test files). What tells them apart is **the cardinality qualifier** — present in IDTA
 *    templates, absent in submission files.
 * When several templates share a semanticId, the one with more elements is used.
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
