/**
 * 형식 → 호기 반영 — 형식(원본) 파일을 고치면 그 변경을 호기 파일로 내려보내되, 현장에서 고친 값은 지킨다(2026-10-13).
 *
 * 개념은 digital-twin 실운영(스피폭스 설비 약 300대)에서 왔다 — 설비 값을 「마스터 + 차이」로 보고, 마스터를 고치면
 * 마지막으로 반영한 마스터 사본과 견주어 바뀐 것만 내려보내며, 현장에서 손댄 것은 건너뛴다
 * (digital-twin_AAS_참조분석_2026-10-13.md §2-1). 코드는 옮기지 않고 3자 비교로 새로 썼다.
 *
 * 세 값을 견준다 — base(마지막으로 반영한 때의 형식) · theirs(지금 형식) · mine(지금 호기).
 *   형식이 바뀌었고(base ≠ theirs) 호기가 base 그대로면 → 반영
 *   형식이 바뀌었고 호기도 base 와 다르면 → 건너뜀(현장에서 고친 값) — 같은 값으로 바뀌었으면 이미 반영됨
 *   형식에 새로 생겼고 호기에 없으면 → 넣기(부모 자리가 없으면 건너뜀)
 *   형식에서 사라졌고 호기 쪽이 base 그대로면 → 빼기, 고쳤으면 건너뜀
 *
 * 비교 단위는 **서브모델 idShort + 요소 경로**다. 호기를 만들 때 id 가 새 이름으로 개명되므로(clone.ts) id 로는 짝이 안 맞는다.
 * 견주는 내용은 잎 요소의 값 칸(value · min · max · contentType · valueType)이다. 묶음(컬렉션·리스트·Entity)은 자리만 본다.
 * 복제 때 개명된 참조값(Asset 주소 등)은 처음부터 호기 값이 base 와 달라 「호기 고유 값」으로 건너뛴다 — 그게 맞다.
 */
import type { Environment } from '@aas/core';

type Node = Record<string, unknown>;

/** 깊은 복사 — 모델은 JSON 이라 이것으로 충분하다(린터는 브라우저·노드 공용이라 structuredClone 에 기대지 않는다) */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 경로 → 비교용 문자열. 묶음은 `{"modelType":…}` 만 */
export type DerivationSnapshot = Record<string, Record<string, string>>;

export type ChangeKind = 'changed' | 'added' | 'removed';
export type ChangeAction = 'apply' | 'skip' | 'same';
export type SkipReason = 'edited-here' | 'parent-missing' | 'submodel-missing';

export interface DerivationChange {
  /** 고유 열쇠 — `서브모델idShort/경로` */
  key: string;
  submodel: string;
  path: string;
  kind: ChangeKind;
  action: ChangeAction;
  reason?: SkipReason;
  /** 사람이 읽는 값 — 없으면 그 자리가 없다 */
  base?: string;
  theirs?: string;
  mine?: string;
}

const LEAF_FIELDS = ['value', 'min', 'max', 'contentType', 'valueType'] as const;

function childrenOf(node: Node): { field: string; items: Node[]; list: boolean } | undefined {
  const type = node['modelType'];
  if (type === 'SubmodelElementCollection' || type === 'SubmodelElementList') {
    const value = node['value'];
    return Array.isArray(value) ? { field: 'value', items: value as Node[], list: type === 'SubmodelElementList' } : { field: 'value', items: [], list: type === 'SubmodelElementList' };
  }
  if (type === 'Entity') {
    const statements = node['statements'];
    return { field: 'statements', items: Array.isArray(statements) ? (statements as Node[]) : [], list: false };
  }
  return undefined;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Node).sort().map((key) => [key, sorted((value as Node)[key])]));
  }
  return value;
}

/** 요소 하나의 비교용 문자열 — 잎은 값 칸, 묶음은 종류만 */
export function comparable(element: Node): string {
  if (childrenOf(element)) return JSON.stringify({ modelType: element['modelType'] });
  const picked: Node = { modelType: element['modelType'] };
  for (const field of LEAF_FIELDS) if (element[field] !== undefined) picked[field] = element[field];
  return JSON.stringify(sorted(picked));
}

/** 사람이 읽는 값 — 표에 그대로 쓴다 */
export function readable(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as Node;
  if (parsed['value'] === undefined && parsed['min'] === undefined && parsed['max'] === undefined) return `(${String(parsed['modelType'])})`;
  if (parsed['min'] !== undefined || parsed['max'] !== undefined) return `${String(parsed['min'] ?? '')}~${String(parsed['max'] ?? '')}`;
  const value = parsed['value'];
  if (Array.isArray(value)) return value.map((entry) => `${String((entry as Node)['language'])}: ${String((entry as Node)['text'])}`).join(' · ');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function walk(items: Node[], prefix: string, list: boolean, visit: (path: string, element: Node) => void): void {
  items.forEach((element, index) => {
    const segment = list ? `[${index}]` : String(element['idShort'] ?? `[${index}]`);
    const path = list ? `${prefix}${segment}` : prefix ? `${prefix}.${segment}` : segment;
    visit(path, element);
    const children = childrenOf(element);
    if (children) walk(children.items, path, children.list, visit);
  });
}

/** 환경 → 서브모델 idShort 마다 경로 → 비교용 문자열 */
export function snapshotOf(environment: Environment): DerivationSnapshot {
  const out: DerivationSnapshot = {};
  for (const submodel of (environment.submodels ?? []) as unknown as Node[]) {
    const name = String(submodel['idShort'] ?? submodel['id']);
    const entries: Record<string, string> = {};
    const elements = submodel['submodelElements'];
    if (Array.isArray(elements)) walk(elements as Node[], '', false, (path, element) => (entries[path] = comparable(element)));
    out[name] = entries;
  }
  return out;
}

const parentOf = (path: string): string => {
  const list = /\[\d+\]$/.exec(path);
  if (list) return path.slice(0, list.index);
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(0, dot);
};

/** 경로 아래(자신 포함)가 base 와 같은가 — 뺄 때 고친 것이 섞였으면 빼지 않는다 */
function subtreeSame(base: Record<string, string>, mine: Record<string, string>, path: string): boolean {
  const under = (entries: Record<string, string>): string =>
    JSON.stringify(
      Object.keys(entries)
        .filter((key) => key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`))
        .sort()
        .map((key) => [key, entries[key]]),
    );
  return under(base) === under(mine);
}

/**
 * 반영 계획. 서브모델 idShort 로 짝을 짓는다 — 호기에만 있는 서브모델(수집 연결 등)은 보지 않는다.
 * 결과에는 「이미 같음」(same)도 넣지 않는다 — 사람이 볼 것만.
 */
export function planDerivation(base: DerivationSnapshot, theirsEnv: Environment, mineEnv: Environment): DerivationChange[] {
  const theirs = snapshotOf(theirsEnv);
  const mine = snapshotOf(mineEnv);
  const changes: DerivationChange[] = [];
  for (const submodel of Object.keys(theirs)) {
    const t = theirs[submodel]!;
    const b = base[submodel] ?? {};
    const m = mine[submodel];
    const touched = new Set([...Object.keys(t), ...Object.keys(b)]);
    for (const path of [...touched].sort()) {
      const bv = b[path];
      const tv = t[path];
      if (bv === tv) continue; // 형식이 그대로다
      const key = `${submodel}/${path}`;
      const mv = m?.[path];
      const shown = { ...(bv !== undefined ? { base: readable(bv)! } : {}), ...(tv !== undefined ? { theirs: readable(tv)! } : {}), ...(mv !== undefined ? { mine: readable(mv)! } : {}) };
      if (!m) {
        changes.push({ key, submodel, path, kind: bv === undefined ? 'added' : tv === undefined ? 'removed' : 'changed', action: 'skip', reason: 'submodel-missing', ...shown });
        continue;
      }
      if (bv !== undefined && tv !== undefined) {
        if (mv === tv) continue; // 이미 같은 값
        changes.push({ key, submodel, path, kind: 'changed', ...(mv === bv ? { action: 'apply' as const } : { action: 'skip' as const, reason: 'edited-here' as const }), ...shown });
      } else if (bv === undefined && tv !== undefined) {
        if (mv === tv) continue;
        if (mv !== undefined) {
          changes.push({ key, submodel, path, kind: 'added', action: 'skip', reason: 'edited-here', ...shown });
          continue;
        }
        const parent = parentOf(path);
        // 부모가 이번에 함께 들어오는 경우는 부모를 넣으면 따라온다 — 따로 넣지 않는다
        if (parent !== '' && b[parent] === undefined && t[parent] !== undefined) continue;
        if (parent !== '' && m[parent] === undefined) {
          changes.push({ key, submodel, path, kind: 'added', action: 'skip', reason: 'parent-missing', ...shown });
          continue;
        }
        changes.push({ key, submodel, path, kind: 'added', action: 'apply', ...shown });
      } else if (bv !== undefined && tv === undefined) {
        if (mv === undefined) continue;
        // 부모가 함께 빠지면 부모를 빼면 따라간다
        const parent = parentOf(path);
        if (parent !== '' && b[parent] !== undefined && t[parent] === undefined) continue;
        changes.push({ key, submodel, path, kind: 'removed', ...(subtreeSame(b, m, path) ? { action: 'apply' as const } : { action: 'skip' as const, reason: 'edited-here' as const }), ...shown });
      }
    }
  }
  return changes;
}

/** 경로의 요소와 그 부모 목록 · 자리 */
function locate(submodel: Node, path: string): { holder: Node[]; index: number; element?: Node } | undefined {
  let items = (submodel['submodelElements'] ?? (submodel['submodelElements'] = [])) as Node[];
  const segments = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const list = /^\[(\d+)\]$/.exec(segment);
    const index = list ? Number(list[1]) : items.findIndex((element) => element['idShort'] === segment);
    const last = i === segments.length - 1;
    if (last) return { holder: items, index: index < 0 ? items.length : index, ...(items[index] ? { element: items[index] } : {}) };
    const next = items[index];
    if (!next) return undefined;
    const children = childrenOf(next);
    if (!children) return undefined;
    items = (next[children.field] ?? (next[children.field] = [])) as Node[];
  }
  return undefined;
}

/**
 * 넣을 자리 — 형식에서 바로 앞에 있던 이웃 중 호기에도 있는 것 **바로 뒤**. 없으면 맨 앞.
 * 리스트 자식은 자리 번호가 곧 이름이라 그 번호 자리에 넣는다.
 */
function insertionIndex(fromHolder: Node[], fromIndex: number, intoHolder: Node[], path: string): number {
  if (/\[\d+\]$/.test(path)) return Math.min(fromIndex, intoHolder.length);
  for (let i = fromIndex - 1; i >= 0; i -= 1) {
    const name = fromHolder[i]?.['idShort'];
    const at = intoHolder.findIndex((element) => element['idShort'] === name);
    if (at >= 0) return at + 1;
  }
  return 0;
}

function findSubmodel(environment: Environment, name: string): Node | undefined {
  return ((environment.submodels ?? []) as unknown as Node[]).find((sm) => String(sm['idShort'] ?? sm['id']) === name);
}

/**
 * 고른 「반영」 변경을 호기에 적용한 새 환경. 원본은 건드리지 않는다.
 * 순서: 빼기(뒤에서부터) → 바꾸기 → 넣기.
 */
export function applyDerivation(mineEnv: Environment, theirsEnv: Environment, changes: readonly DerivationChange[]): Environment {
  const next = clone(mineEnv);
  const chosen = changes.filter((change) => change.action === 'apply');
  const removals = chosen.filter((c) => c.kind === 'removed').sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true }));
  for (const change of removals) {
    const submodel = findSubmodel(next, change.submodel);
    const spot = submodel ? locate(submodel, change.path) : undefined;
    if (spot?.element) spot.holder.splice(spot.index, 1);
  }
  for (const change of chosen.filter((c) => c.kind === 'changed')) {
    const target = findSubmodel(next, change.submodel);
    const source = findSubmodel(theirsEnv, change.submodel);
    const into = target ? locate(target, change.path)?.element : undefined;
    const from = source ? locate(source, change.path)?.element : undefined;
    if (!into || !from) continue;
    for (const field of LEAF_FIELDS) {
      if (from[field] === undefined) delete into[field];
      else into[field] = clone(from[field]);
    }
  }
  for (const change of chosen.filter((c) => c.kind === 'added').sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))) {
    const target = findSubmodel(next, change.submodel);
    const source = findSubmodel(theirsEnv, change.submodel);
    const origin = source ? locate(source, change.path) : undefined;
    const from = origin?.element;
    const spot = target ? locate(target, change.path) : undefined;
    if (!origin || !from || !spot || spot.element) continue;
    spot.holder.splice(insertionIndex(origin.holder, origin.index, spot.holder, change.path), 0, clone(from));
  }
  return next;
}

/**
 * 반영한 뒤의 base — 지금 형식이 기준이 된다. 다만 고르지 않은 「반영」 줄은 옛 base 를 남긴다 —
 * 그래야 다음에도 「반영할 것」으로 다시 보인다(지금 형식으로 덮으면 현장에서 고친 것처럼 보여 영영 묻힌다).
 */
export function nextSnapshot(base: DerivationSnapshot, theirsEnv: Environment, changes: readonly DerivationChange[], appliedKeys: ReadonlySet<string>): DerivationSnapshot {
  const out = clone(snapshotOf(theirsEnv));
  for (const change of changes) {
    if (change.action !== 'apply' || appliedKeys.has(change.key)) continue;
    const entries = (out[change.submodel] ??= {});
    const old = base[change.submodel]?.[change.path];
    if (old === undefined) delete entries[change.path];
    else entries[change.path] = old;
  }
  return out;
}
