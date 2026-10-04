/**
 * 「누가 바꿨나」 — 요청 하나가 도는 동안의 **행위자**.
 *
 * 왜 매개변수로 안 넘기고 이렇게 두는가:
 *   모델을 바꾸는 호출 자리가 라우트에만 서른 군데쯤 된다. 거기에 actor를 일일이 끼워
 *   넣으면 **한 군데만 빠뜨려도 그 변경은 「누가」가 빈 채로 남는다.** 감사 기록에서
 *   "대부분 남는다"는 안 남는 것만 못하다 — 빠진 줄이 사고 당시의 줄일 수 있다.
 *   그래서 들어오는 길목 한 곳(api.ts)에서 한 번 깔고, 저장소가 집어 쓴다.
 *
 * AsyncLocalStorage는 Node 내장이고 **비동기 문맥별로** 값을 든다. 요청 두 개가 겹쳐
 * 돌아도 서로의 행위자를 보지 않는다 — 모듈 전역 변수 한 개로 했다면 바로 섞였을 자리다.
 *
 * 🔴 명시로 준 `options.actor`가 언제나 이긴다. 저장소를 직접 쓰는 쪽(수집기·시험)은
 *    이 문맥 밖에서 돌기 때문에, 숨은 값이 명시를 덮으면 설명할 수 없는 기록이 남는다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Actor } from './types.js';

const storage = new AsyncLocalStorage<Actor>();

/** `fn`이 도는 동안(그 안에서 기다리는 비동기 호출까지) 행위자를 `actor`로 둔다 */
export function runAsActor<T>(actor: Actor | undefined, fn: () => T): T {
  return actor === undefined ? fn() : storage.run(actor, fn);
}

/** 지금 문맥의 행위자. 문맥 밖이면 undefined */
export function currentActor(): Actor | undefined {
  return storage.getStore();
}

/** 저장소 구현이 이력을 쓸 때 부른다 — 명시가 있으면 그것, 없으면 문맥 */
export function resolveActor(explicit?: Actor): Actor | undefined {
  return explicit ?? currentActor();
}

/**
 * 이력 한 줄에 붙일 `actorId`·`actorName`.
 *
 * 비었으면 **키 자체를 만들지 않는다** — `actorId: undefined`를 넣으면 JSON으로 왕복하는
 * 폴더 저장소에서 `"actorId": null`이 되어, 「기록 없음」과 「누가 null인 사람」이 섞인다.
 */
export function actorFields(explicit?: Actor): { actorId?: string; actorName?: string } {
  const actor = resolveActor(explicit);
  return actor === undefined ? {} : { actorId: actor.id, actorName: actor.name };
}
