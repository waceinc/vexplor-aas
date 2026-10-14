/**
 * The change cause of a request (`vxcause` on model events, docs/design/integration-v1.md §13.3).
 *
 * Decided from the matched route pattern in one place (api.ts), like the actor — a receiver can then tell an edit
 * from an undo, a Quick Fix or an import without the routes having to say it.
 */
import type { ChangeContext } from '@aas/store';

import { newChangeSetId } from './ids.js';

const IMPORT_PATTERNS = new Set(['/packages', '/packages/new', '/packages/:packageId/clone', '/bundles']);

export function causeOf(method: string, pattern: string): string {
  if (pattern === '/packages/:packageId/undo') return 'undo';
  if (pattern === '/packages/:packageId/redo') return 'redo';
  if (pattern === '/packages/:packageId/fix') return 'fix';
  if (pattern === '/packages/:packageId/derivation/apply') return 'derivation';
  if (IMPORT_PATTERNS.has(pattern) || (method === 'PUT' && pattern === '/packages/:packageId')) return 'import';
  return 'edit';
}

/** One change set per request — every model event of this request shares it */
export function changeContextFor(method: string, pattern: string): ChangeContext {
  return { cause: causeOf(method, pattern), changeSetId: newChangeSetId() };
}
