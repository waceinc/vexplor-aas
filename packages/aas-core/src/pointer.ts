/**
 * RFC 6901 JSON Pointer resolution.
 *
 * Used so auto-fix can go straight to the location the linter reported.
 * Pairs with the pointer produced by the traverser (traverse.ts).
 */
import { fill, tr } from './i18n/index.js';

export interface PointerTarget {
  /** Object or array holding the value */
  container: Record<string, unknown> | unknown[];
  /** Key within container (an index string for arrays) */
  key: string;
  /** Current value. undefined if it does not exist yet */
  value: unknown;
}

/** Unescapes a JSON Pointer segment */
function unescape(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(fill(tr('JSON Pointer는 /로 시작해야 합니다: {0}'), { 0: pointer }));
  return pointer.slice(1).split('/').map(unescape);
}

function isIndexable(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

/**
 * Finds the location a pointer points to.
 * Returns container and key even if the last segment does not exist yet
 * (needed by fixes that fill in a new value).
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

/** Reads the value at the pointer location */
export function getAtPointer(root: unknown, pointer: string): unknown {
  return resolvePointer(root, pointer)?.value;
}

/** Writes a value at the pointer location. true on success */
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

/** Deletes the value at the pointer location. true on success */
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
 * Returns the parent location of a pointer.
 * e.g. /submodels/3/semanticId → /submodels/3
 */
export function parentPointer(pointer: string): string {
  const idx = pointer.lastIndexOf('/');
  return idx <= 0 ? '' : pointer.slice(0, idx);
}
