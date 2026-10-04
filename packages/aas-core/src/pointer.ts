/**
 * RFC 6901 JSON Pointer 해석.
 *
 * 린터가 보고한 위치를 자동수정이 그대로 찾아가는 데 쓴다.
 * 순회기(traverse.ts)가 만든 pointer와 짝을 이룬다.
 */

export interface PointerTarget {
  /** 값을 담고 있는 객체 또는 배열 */
  container: Record<string, unknown> | unknown[];
  /** container 안에서의 키 (배열이면 인덱스 문자열) */
  key: string;
  /** 현재 값. 아직 없으면 undefined */
  value: unknown;
}

/** JSON Pointer 세그먼트 역이스케이프 */
function unescape(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`JSON Pointer는 /로 시작해야 합니다: ${pointer}`);
  return pointer.slice(1).split('/').map(unescape);
}

function isIndexable(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

/**
 * 포인터가 가리키는 위치를 찾는다.
 * 마지막 세그먼트가 아직 존재하지 않아도 container와 key는 돌려준다
 * (값을 새로 채워 넣는 교정에 필요하다).
 */
export function resolvePointer(root: unknown, pointer: string): PointerTarget | undefined {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return undefined;

  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!isIndexable(current)) return undefined;
    const segment = segments[i]!;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Record<string, unknown>)[segment];
  }
  if (!isIndexable(current)) return undefined;

  const key = segments[segments.length - 1]!;
  const value = Array.isArray(current)
    ? current[Number(key)]
    : (current as Record<string, unknown>)[key];

  return { container: current, key, value };
}

/** 포인터 위치의 값을 읽는다 */
export function getAtPointer(root: unknown, pointer: string): unknown {
  return resolvePointer(root, pointer)?.value;
}

/** 포인터 위치에 값을 쓴다. 성공하면 true */
export function setAtPointer(root: unknown, pointer: string, value: unknown): boolean {
  const target = resolvePointer(root, pointer);
  if (!target) return false;
  if (Array.isArray(target.container)) {
    const index = Number(target.key);
    if (!Number.isInteger(index)) return false;
    target.container[index] = value;
  } else {
    target.container[target.key] = value;
  }
  return true;
}

/** 포인터 위치의 값을 지운다. 성공하면 true */
export function deleteAtPointer(root: unknown, pointer: string): boolean {
  const target = resolvePointer(root, pointer);
  if (!target) return false;
  if (Array.isArray(target.container)) {
    const index = Number(target.key);
    if (!Number.isInteger(index)) return false;
    target.container.splice(index, 1);
  } else {
    delete target.container[target.key];
  }
  return true;
}

/**
 * 포인터의 부모 위치를 돌려준다.
 * 예: /submodels/3/semanticId → /submodels/3
 */
export function parentPointer(pointer: string): string {
  const idx = pointer.lastIndexOf('/');
  return idx <= 0 ? '' : pointer.slice(0, idx);
}
