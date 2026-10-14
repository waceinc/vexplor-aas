/**
 * "Why and as part of what it changed" — the change **cause** (`edit`, `undo`, `import`, `external-refs`, …) and the
 * change-set id for the duration of a single request. Model events carry both (`vxcause`, `vxchangeset`).
 *
 * Same reasoning and mechanism as actor.ts: set once at the API entry point next to `runAsActor`, read by the store
 * implementations when they build model events — so no mutating call site can forget it.
 * A separate AsyncLocalStorage (not a field on the actor) because a change context also exists without an actor
 * (open server, system jobs) and nested scopes replace it independently (external-refs projection inside a request).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ChangeContext {
  cause?: string;
  changeSetId?: string;
}

const storage = new AsyncLocalStorage<ChangeContext>();

/** Sets the change context while `fn` runs (including async calls awaited inside it). undefined leaves the outer context */
export function runWithChange<T>(context: ChangeContext | undefined, fn: () => T): T {
  return context === undefined ? fn() : storage.run({ ...context }, fn);
}

/** The change context of the current call. undefined outside a context */
export function currentChange(): ChangeContext | undefined {
  return storage.getStore();
}

/**
 * `cause`/`changeSetId` to attach to one event row. Like `actorFields`, empty keys are not created at all — the
 * folder store round-trips through JSON, where `undefined` would turn into `null`.
 */
export function changeFields(): { cause?: string; changeSetId?: string } {
  const context = currentChange();
  const out: { cause?: string; changeSetId?: string } = {};
  if (context?.cause !== undefined) out.cause = context.cause;
  if (context?.changeSetId !== undefined) out.changeSetId = context.changeSetId;
  return out;
}
