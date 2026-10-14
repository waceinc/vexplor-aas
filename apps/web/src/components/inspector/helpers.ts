/**
 * Small helpers for the property editor — whether a spot can be renamed · attached file name · valueType description.
 * Split out of components/Inspector.tsx (componentization, 2026-10-13).
 */
import { tr } from '../../i18n.js';
import type { TreeNode } from '../../model.js';

export interface LangText {
  language: string;
  text: string;
}

/**
 * Whether this spot can be renamed.
 * Submodels and ordinary elements can; **list children cannot** (they are addressed by position).
 * AAS, AssetInformation, and ConceptDescription are not edit targets of this screen.
 */
export function renameable(node: TreeNode): boolean {
  if (node.modelType === 'Submodel') return true;
  if (node.idShortPath === undefined) return false;
  const last = node.idShortPath.split('.').at(-1) ?? '';
  return !last.endsWith(']');
}

/** Extract only the human-readable file name from File.value (`file:///aasx/suppl/manual.pdf`) */
export function attachedName(raw: Record<string, unknown>): string | undefined {
  const value = typeof raw['value'] === 'string' ? (raw['value'] as string) : undefined;
  if (!value) return undefined;
  const path = value.replace(/^file:\/\//i, '');
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name || path;
}

/** Same wording as the add form — the two screens must not describe it differently */
export const VALUE_TYPE_HINTS: Record<string, string> = {
  'xs:string': tr('글자'),
  'xs:boolean': tr('참/거짓'),
  'xs:int': tr('정수'),
  'xs:double': tr('소수'),
  'xs:date': tr('날짜'),
  'xs:dateTime': tr('날짜+시각'),
  'xs:anyURI': tr('주소 (URL·IRI)'),
};
