/**
 * 되돌리기(Undo)·다시 하기(Redo) — 패키지 단위.
 *
 * 사용자가 바란 것은 "실수했을 때 뒤로가기 버튼"이다. 서브모델별 이력(history/restore)은
 * 있었지만 ① 어느 서브모델의 이력을 열어야 하는지 알아야 하고 ② 시각을 골라야 해서 "한 번 눌러
 * 방금 것을 되돌리기"가 되지 않았다.
 *
 * 방식: **모델을 바꾸는 요청 직전의 Environment를 통째로 찍어 둔다**(api.ts 디스패처가 한다).
 * 어떤 종류의 변경이든(값 편집·삭제·순서·복제·자동 고치기·AID·가져오기) 같은 길로 되돌아간다 —
 * 연산마다 역연산을 짜지 않는다. 되돌릴 때는 지금과 찍어 둔 것을 **Identifiable 단위로 견주어**
 * 달라진 것만 update/create/delete 한다. 그래서 되돌리기도 서브모델 이력에 정상 변경으로 남는다.
 *
 * 한계(알고 정한 것):
 *  - 메모리에만 있다. 서버를 다시 띄우면 비워진다 — 되돌리기는 "이 자리에서 방금"의 개념이다.
 *    영구 이력은 store.history가 따로 든다.
 *  - 첨부 파일·썸네일·패키지 이름은 안 본다. 모델(Environment)만.
 *  - 다른 사람이 낀 변경도 되돌아간다(패키지가 공유 작업물이라 사용자 구분이 없다).
 *  - 지웠던 Identifiable을 되살리면 배열 끝에 붙는다(ordinal은 새로 받는다). 순서는 export에서
 *    무손실이 아닐 수 있으나 내용은 그대로다.
 */
import type { Environment } from '@aas/core';
import { ENVIRONMENT_FIELD, type AasStore, type IdentifiableModelType } from '@aas/store';

export const UNDO_DEPTH = 30;

export interface Snapshot {
  /** 그때의 Environment. 견주기 위해 문자열로 든다 */
  json: string;
  /** 사람이 읽는 변경 설명 — "무엇을 되돌리는지" */
  label: string;
  takenAt: string;
}

export interface UndoStatus {
  /** 최근 것이 앞 */
  undo: string[];
  redo: string[];
}

interface Stacks {
  undo: Snapshot[];
  redo: Snapshot[];
}

export class UndoStack {
  private readonly stacks = new Map<string, Stacks>();

  constructor(
    private readonly store: AasStore,
    private readonly depth = UNDO_DEPTH,
  ) {}

  /**
   * 지금 상태를 찍는다. 패키지가 없으면 undefined.
   *
   * `actorName`을 주면 설명 뒤에 붙인다 — 되돌리기 목록이 「무엇을」에 더해 「누가」를
   * 보여 준다. 공용 작업물이라 남이 낀 변경도 같은 더미에 쌓이기 때문이다.
   * 🔴 다시 찍을 때(commit·shift)는 주지 않는다 — 이미 붙은 설명에 또 붙으면 겹친다.
   */
  async capture(packageId: string, label: string, actorName?: string): Promise<Snapshot | undefined> {
    if (!(await this.store.getPackage(packageId))) return undefined;
    const environment = await this.store.getEnvironment(packageId);
    const described = actorName === undefined ? label : `${label} — ${actorName}`;
    return { json: JSON.stringify(environment), label: described, takenAt: new Date().toISOString() };
  }

  /**
   * 변경 요청이 끝난 뒤 — 실제로 모델이 달라졌으면 직전 스냅샷을 쌓고 redo를 비운다.
   * (수집·첨부처럼 리비전만 오르고 모델은 그대로인 요청은 쌓이지 않는다)
   */
  async commit(packageId: string, before: Snapshot): Promise<boolean> {
    const after = await this.capture(packageId, before.label);
    if (!after || after.json === before.json) return false;
    const stacks = this.of(packageId);
    stacks.undo.unshift(before);
    if (stacks.undo.length > this.depth) stacks.undo.length = this.depth;
    stacks.redo = [];
    return true;
  }

  status(packageId: string): UndoStatus {
    const stacks = this.stacks.get(packageId);
    return {
      undo: stacks?.undo.map((s) => s.label) ?? [],
      redo: stacks?.redo.map((s) => s.label) ?? [],
    };
  }

  /** 되돌린 변경의 설명을 돌려준다. 없으면 undefined */
  async undo(packageId: string): Promise<string | undefined> {
    return this.shift(packageId, 'undo');
  }

  async redo(packageId: string): Promise<string | undefined> {
    return this.shift(packageId, 'redo');
  }

  forget(packageId: string): void {
    this.stacks.delete(packageId);
  }

  private of(packageId: string): Stacks {
    let stacks = this.stacks.get(packageId);
    if (!stacks) {
      stacks = { undo: [], redo: [] };
      this.stacks.set(packageId, stacks);
    }
    return stacks;
  }

  private async shift(packageId: string, from: 'undo' | 'redo'): Promise<string | undefined> {
    const stacks = this.of(packageId);
    const target = stacks[from][0];
    if (!target) return undefined;
    const current = await this.capture(packageId, target.label);
    if (!current) {
      this.forget(packageId);
      return undefined;
    }
    await applyEnvironment(this.store, packageId, JSON.parse(target.json) as Environment);
    stacks[from].shift();
    stacks[from === 'undo' ? 'redo' : 'undo'].unshift(current);
    return target.label;
  }
}

/** 지금 저장된 것을 `target`과 같게 만든다 — 달라진 Identifiable만 손댄다 */
export async function applyEnvironment(store: AasStore, packageId: string, target: Environment): Promise<void> {
  const current = await store.getEnvironment(packageId);
  const key = (modelType: string, id: string) => `${modelType} ${id}`;
  const wanted = new Map<
    string,
    { modelType: IdentifiableModelType; id: string; content: Record<string, unknown> }
  >();
  const have = new Map<string, Record<string, unknown>>();

  for (const [modelType, field] of Object.entries(ENVIRONMENT_FIELD) as [
    IdentifiableModelType,
    keyof Environment,
  ][]) {
    for (const item of (target[field] ?? []) as unknown as Record<string, unknown>[]) {
      wanted.set(key(modelType, String(item['id'])), { modelType, id: String(item['id']), content: item });
    }
    for (const item of (current[field] ?? []) as unknown as Record<string, unknown>[]) {
      have.set(key(modelType, String(item['id'])), item);
    }
  }

  // 지울 것을 먼저 — 만들 때 id가 부딪히지 않게
  for (const k of have.keys()) {
    if (!wanted.has(k)) {
      const space = k.indexOf(' ');
      await store.deleteIdentifiable(packageId, k.slice(0, space) as IdentifiableModelType, k.slice(space + 1));
    }
  }
  for (const [k, item] of wanted) {
    const existing = have.get(k);
    if (existing === undefined) {
      await store.createIdentifiable(packageId, item.content);
    } else if (JSON.stringify(existing) !== JSON.stringify(item.content)) {
      await store.updateIdentifiable(packageId, item.modelType, item.id, item.content);
    }
  }
}

/**
 * 요청에서 사람이 읽는 변경 설명을 만든다 — 되돌리기 버튼의 title이 된다.
 * 경로 규칙마다 정확히 맞추려 하지 않는다: 대상 이름 + 동작 정도면 "무엇을 되돌리는지" 알 수 있다.
 */
export function describeChange(method: string, path: string): string {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const segments = path.split('/').filter(Boolean).map(decode);
  const last = segments[segments.length - 1] ?? '';
  const at = (name: string) => segments.indexOf(name);

  if (at('fix') >= 0) return '자동 고치기';
  if (at('restore') >= 0) return '이력에서 되돌리기';
  if (at('aid') >= 0 || at('interfaces') >= 0) return '수집 연결 만들기';
  if (at('hierarchy') >= 0) return '구성 편집';
  if (at('import-submodel') >= 0) return '다른 파일에서 가져오기';

  const elements = at('submodel-elements');
  if (elements >= 0) {
    const pathPart = segments[elements + 1];
    const target = pathPart ? (pathPart.split('.').pop() ?? pathPart) : undefined;
    const name = target ? `「${target}」` : '요소';
    if (last === 'move') return `${name} 순서 바꾸기`;
    if (last === 'duplicate') return `${name} 복제`;
    if (last === 'attachment') return `${name} 첨부 바꾸기`;
    if (method === 'DELETE') return `${name} 지움`;
    if (method === 'POST') return pathPart ? `${name} 밑에 요소 추가` : '요소 추가';
    return `${name} 고침`;
  }
  const submodels = at('submodels');
  if (submodels >= 0) {
    if (method === 'DELETE') return '서브모델 지움';
    if (method === 'POST' && segments[submodels + 1] === undefined) return '서브모델 추가';
    return '서브모델 고침';
  }
  if (at('concept-descriptions') >= 0) {
    if (method === 'DELETE') return '개념 설명 지움';
    if (method === 'POST') return '개념 설명 추가';
    return '개념 설명 고침';
  }
  if (at('shells') >= 0) return 'AAS 고침';
  if (segments.length === 2 && method === 'PUT') return '파일 다시 올림';
  return `${method} ${segments.slice(2).join('/') || path}`;
}
