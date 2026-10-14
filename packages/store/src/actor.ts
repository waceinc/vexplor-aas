/**
 * "Who changed it" — the **actor** for the duration of a single request.
 *
 * Why this instead of passing it as a parameter:
 *   There are roughly thirty call sites that modify the model in the routes alone. Threading actor
 *   through each of them means **missing just one leaves that change with an empty "who".** For an
 *   audit log, "mostly recorded" is worse than not recorded — the missing row may be the one from the incident.
 *   So it is set once at the single entry point (api.ts) and the store picks it up.
 *
 * AsyncLocalStorage is built into Node and holds a value **per async context**. Even when two requests
 * overlap, neither sees the other's actor — a single module-level global would have mixed them right here.
 *
 * Important: an explicitly passed `options.actor` always wins. Callers that use the store directly (collector, tests)
 *    run outside this context, so if a hidden value overrode the explicit one, the log would contain unexplainable entries.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Actor } from './types.js';

const storage = new AsyncLocalStorage<Actor>();

/** Sets the actor to `actor` while `fn` runs (including async calls awaited inside it) */
export function runAsActor<T>(actor: Actor | undefined, fn: () => T): T {
  return actor === undefined ? fn() : storage.run(actor, fn);
}

/** The actor of the current context. undefined outside a context */
export function currentActor(): Actor | undefined {
  return storage.getStore();
}

/** Called by store implementations when writing history — explicit if given, otherwise the context */
export function resolveActor(explicit?: Actor): Actor | undefined {
  return explicit ?? currentActor();
}

/**
 * `actorId`/`actorName` to attach to one history row.
 *
 * When empty, **do not create the keys at all** — putting `actorId: undefined` becomes `"actorId": null`
 * in the folder store that round-trips through JSON, mixing "no record" with "a person who is null".
 */
export function actorFields(explicit?: Actor): { actorId?: string; actorName?: string } {
  const actor = resolveActor(explicit);
  return actor === undefined ? {} : { actorId: actor.id, actorName: actor.name };
}
