/**
 * 속성 편집 칸의 작은 도우미 — 이름을 바꿀 수 있는 자리인가 · 붙은 파일 이름 · valueType 설명.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화).
 */
import { tr } from '../../i18n.js';
import type { TreeNode } from '../../model.js';

export interface LangText {
  language: string;
  text: string;
}

/**
 * 이름을 바꿀 수 있는 자리인가.
 * Submodel과 일반 요소는 되고, **리스트 자식은 안 된다**(순서로 가리키는 자리다).
 * AAS·AssetInformation·ConceptDescription은 이 화면의 편집 대상이 아니다.
 */
export function renameable(node: TreeNode): boolean {
  if (node.modelType === 'Submodel') return true;
  if (node.idShortPath === undefined) return false;
  const last = node.idShortPath.split('.').at(-1) ?? '';
  return !last.endsWith(']');
}

/** File.value(`file:///aasx/suppl/매뉴얼.pdf`)에서 사람이 읽을 파일명만 꺼낸다 */
export function attachedName(raw: Record<string, unknown>): string | undefined {
  const value = typeof raw['value'] === 'string' ? (raw['value'] as string) : undefined;
  if (!value) return undefined;
  const path = value.replace(/^file:\/\//i, '');
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name || path;
}

/** 추가 폼과 같은 말 — 두 화면이 다른 설명을 하면 안 된다 */
export const VALUE_TYPE_HINTS: Record<string, string> = {
  'xs:string': tr('글자'),
  'xs:boolean': tr('참/거짓'),
  'xs:int': tr('정수'),
  'xs:double': tr('소수'),
  'xs:date': tr('날짜'),
  'xs:dateTime': tr('날짜+시각'),
  'xs:anyURI': tr('주소 (URL·IRI)'),
};
