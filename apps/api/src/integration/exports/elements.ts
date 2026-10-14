/**
 * Element walking shared by the export projections (docs/design/integration-v1.md §4.4).
 *
 * Why a separate walker instead of `resolveIdShortPath`: exports look elements up by **semanticId first, idShort
 * second** (idShort is renameable, semanticIds of standard templates are not), and they must also tell the caller the
 * Part 2 idShortPath of what they found (`sourcePaths`, attachment URLs). List items are addressed by index in that
 * path because AAS V3.0 list items have no idShort — the index is only used to build a link, never as a join key.
 */
import type { Environment } from '@aas/core';

export type Json = Record<string, unknown>;

/** One element plus its Part 2 idShortPath inside its submodel */
export interface Located {
  element: Json;
  path: string;
}

export function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

export function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Json => item !== undefined) : [];
}

export function idShortOf(element: Json): string | undefined {
  return typeof element['idShort'] === 'string' ? element['idShort'] : undefined;
}

export function modelTypeOf(element: Json): string {
  return typeof element['modelType'] === 'string' ? element['modelType'] : '';
}

/** Children of collections, lists and entities (entities hold theirs in `statements`) */
export function childrenOf(element: Json): Json[] {
  const type = modelTypeOf(element);
  if (type === 'SubmodelElementCollection' || type === 'SubmodelElementList') return asArray(element['value']);
  if (type === 'Entity') return asArray(element['statements']);
  return [];
}

/** Last key value of the semanticId — the IRDI / IRI that identifies the concept */
export function semanticIdOf(element: Json): string | undefined {
  const keys = asArray(asRecord(element['semanticId'])?.['keys']);
  const last = keys[keys.length - 1]?.['value'];
  return typeof last === 'string' ? last : undefined;
}

/** idShortPath of a child: `a.b` for a named child, `a[3]` for a list item */
export function childPath(parentPath: string, parent: Json | undefined, child: Json, index: number): string {
  if (parent && modelTypeOf(parent) === 'SubmodelElementList') return `${parentPath}[${index}]`;
  const name = idShortOf(child) ?? '';
  return parentPath === '' ? name : `${parentPath}.${name}`;
}

/** Direct children with their paths */
export function locatedChildren(parent: Located): Located[] {
  return childrenOf(parent.element).map((child, index) => ({
    element: child,
    path: childPath(parent.path, parent.element, child, index),
  }));
}

/** Top-level elements of a submodel with their paths */
export function topElements(submodel: Json): Located[] {
  return asArray(submodel['submodelElements']).map((element) => ({ element, path: idShortOf(element) ?? '' }));
}

/** Every element below (depth first, model order) */
export function walk(start: readonly Located[]): Located[] {
  const out: Located[] = [];
  const visit = (items: readonly Located[]): void => {
    for (const item of items) {
      out.push(item);
      visit(locatedChildren(item));
    }
  };
  visit(start);
  return out;
}

/**
 * The first element matching one of the semanticIds anywhere below, else the first with one of the idShorts.
 * semanticIds are compared exactly — a different version suffix is a different concept.
 */
export function findElement(
  start: readonly Located[],
  semanticIds: readonly string[],
  idShorts: readonly string[],
): Located | undefined {
  const all = walk(start);
  for (const id of semanticIds) {
    const found = all.find((item) => semanticIdOf(item.element) === id);
    if (found) return found;
  }
  for (const name of idShorts) {
    const found = all.find((item) => idShortOf(item.element) === name);
    if (found) return found;
  }
  return undefined;
}

/** Direct child by idShort */
export function child(parent: Located, idShort: string): Located | undefined {
  return locatedChildren(parent).find((item) => idShortOf(item.element) === idShort);
}

/** Language-tagged strings of a MultiLanguageProperty */
export function langStrings(element: Json): { language: string; text: string }[] {
  return asArray(element['value'])
    .filter((entry) => typeof entry['language'] === 'string' && typeof entry['text'] === 'string')
    .map((entry) => ({ language: String(entry['language']), text: String(entry['text']) }));
}

/**
 * Text of a Property or MultiLanguageProperty. MLP language: `lang`, then `en`, then the first entry.
 * Empty text counts as absent (null) — exports list absent values in `missing` instead of writing "".
 */
export function textOf(element: Json | undefined, lang: string): string | null {
  if (!element) return null;
  if (modelTypeOf(element) === 'MultiLanguageProperty') {
    const strings = langStrings(element).filter((entry) => entry.text.trim() !== '');
    const pick =
      strings.find((entry) => entry.language.toLowerCase() === lang.toLowerCase()) ??
      strings.find((entry) => entry.language.toLowerCase() === 'en') ??
      strings[0];
    return pick ? pick.text : null;
  }
  const value = element['value'];
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Numeric value of a Property (xs:double text) — null when absent or not a finite number */
export function numberOf(element: Json | undefined): number | null {
  const text = textOf(element, 'en');
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** `true` / `false` of a boolean Property; null when absent or anything else (never guessed) */
export function booleanOf(element: Json | undefined): boolean | null {
  const text = textOf(element, 'en')?.trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
}

/** Submodels referenced by the shell (all submodels when the shell references none — a hand-made file) */
export function submodelsOf(environment: Environment, shell: Json | undefined): Json[] {
  const all = asArray(environment.submodels as unknown);
  const refs = asArray(shell?.['submodels'])
    .map((reference) => asArray(reference['keys']).find((key) => key['type'] === 'Submodel')?.['value'])
    .filter((value): value is string => typeof value === 'string');
  if (refs.length === 0) return all;
  const wanted = new Set(refs);
  return all.filter((submodel) => wanted.has(String(submodel['id'])));
}

/** A submodel by idShort, or by a semanticId fragment (`/Nameplate/`, `MaintenanceInstructions`) */
export function findSubmodel(submodels: readonly Json[], idShorts: readonly string[], semanticFragment?: RegExp): Json | undefined {
  for (const name of idShorts) {
    const found = submodels.find((submodel) => idShortOf(submodel) === name);
    if (found) return found;
  }
  if (!semanticFragment) return undefined;
  return submodels.find((submodel) => semanticFragment.test(semanticIdOf(submodel) ?? ''));
}

export function shellsOf(environment: Environment): Json[] {
  return asArray(environment.assetAdministrationShells as unknown);
}

export function assetInformationOf(shell: Json | undefined): Json {
  return asRecord(shell?.['assetInformation']) ?? {};
}

/** `name=value` pairs of the shell's specificAssetIds, in model order */
export function specificAssetIdsOf(shell: Json | undefined): { name: string; value: string }[] {
  return asArray(assetInformationOf(shell)['specificAssetIds'])
    .filter((entry) => typeof entry['name'] === 'string' && typeof entry['value'] === 'string')
    .map((entry) => ({ name: String(entry['name']), value: String(entry['value']) }));
}

/** Package part a File element points at (`file:///x.pdf` → `/x.pdf`); undefined for empty values and web URLs */
export function packagePartOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  if (/^https?:\/\//i.test(value)) return undefined;
  const withoutScheme = value.replace(/^file:\/\//i, '');
  return withoutScheme.startsWith('/') ? withoutScheme : `/${withoutScheme}`;
}
