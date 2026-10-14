/**
 * CSV 로 값 채우기 — 계산부(화면 없음). 설비 대장(한 줄 = 설비 한 대)의 열을 서브모델의 값 항목에 대응시키고,
 * 줄마다 어느 파일의 무엇이 어떻게 바뀌는지 미리 셈한다. 저장은 화면(CsvFillDialog)이 한다.
 *
 * digital-twin 의 「MES 열 → AAS 경로 대응표」와 4단계 가져오기(연결 → 표 → 미리보기 + 열 대응 → 가져오기) 개념을
 * CSV 로 옮겼다(DB 직접 연결은 자격 증명 보관 부담 때문에 넣지 않는다). 대응은 이름으로 추측하되 사람이 고친다.
 * 빈 칸은 값을 지우지 않는다 — 대장에 비어 있는 것은 「모른다」이지 「없다」가 아니다.
 */

export interface Leaf {
  /** idShort 를 점으로 이은 경로 */
  path: string;
  /** 사람이 읽는 이름(상위 › 하위) */
  label: string;
  current: string;
}

/** 서브모델 JSON 의 값 항목(Property · MLP · Range) — 컬렉션 · Entity 안까지 내려간다(목록은 순번이라 건너뛴다) */
export function leavesOf(submodel: Record<string, unknown>): Leaf[] {
  const out: Leaf[] = [];
  const walk = (elements: unknown, prefix: string, label: string): void => {
    if (!Array.isArray(elements)) return;
    for (const raw of elements as Record<string, unknown>[]) {
      const idShort = String(raw['idShort'] ?? '');
      if (!idShort) continue;
      const path = prefix ? `${prefix}.${idShort}` : idShort;
      const name = label ? `${label} › ${idShort}` : idShort;
      const type = raw['modelType'];
      if (type === 'Property') out.push({ path, label: name, current: String(raw['value'] ?? '') });
      else if (type === 'MultiLanguageProperty') {
        const list = (raw['value'] as { text?: string }[] | undefined) ?? [];
        out.push({ path, label: name, current: list[0]?.text ?? '' });
      } else if (type === 'Range') out.push({ path, label: name, current: `${String(raw['min'] ?? '')}~${String(raw['max'] ?? '')}` });
      else if (type === 'SubmodelElementCollection') walk(raw['value'], path, name);
      else if (type === 'Entity') walk(raw['statements'], path, name);
    }
  };
  walk(submodel['submodelElements'], '', '');
  return out;
}

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');

/** 열 이름으로 값 항목을 고른다 — 마지막 idShort 와 같거나 전체 경로와 같을 때만(비슷한 것은 고르지 않는다) */
export function suggestTarget(header: string, leaves: readonly Leaf[]): string | undefined {
  const want = norm(header);
  if (!want) return undefined;
  const byLast = leaves.filter((leaf) => norm(leaf.path.split('.').pop() ?? '') === want);
  if (byLast.length === 1) return byLast[0]!.path;
  return leaves.find((leaf) => norm(leaf.path) === want)?.path;
}

/** 설비를 가리키는 열 — 이름이 그런 열이 있으면 그것, 없으면 첫 열 */
export function guessKeyColumn(headers: readonly string[]): number {
  const index = headers.findIndex((header) => /^(name|assetname|idshort|asset|equipment|설비|설비명|설비이름|이름|장비|장비명)$/i.test(norm(header)));
  return index >= 0 ? index : 0;
}

export interface FileTarget {
  packageId: string;
  /** 이 파일을 부를 수 있는 이름들 — AAS idShort · 파일명(확장자 뺌) */
  names: readonly string[];
  /** 고른 서브모델(같은 idShort) — 없으면 그 파일에는 넣을 자리가 없다 */
  submodel?: { id: string; content: Record<string, unknown> };
}

export interface RowPlan {
  key: string;
  packageId?: string;
  problem?: 'no-file' | 'no-submodel' | 'duplicate';
  changes: { path: string; before: string; after: string }[];
}

export function planFill(input: {
  rows: readonly (readonly string[])[];
  keyColumn: number;
  /** 열마다 넣을 경로 — 비면 그 열은 쓰지 않는다 */
  mapping: readonly (string | undefined)[];
  files: readonly FileTarget[];
}): RowPlan[] {
  const used = new Set<string>();
  return input.rows.map((row) => {
    const key = (row[input.keyColumn] ?? '').trim();
    const file = input.files.find((target) => target.names.some((name) => name.toLowerCase() === key.toLowerCase()));
    if (!file) return { key, problem: 'no-file', changes: [] };
    if (used.has(file.packageId)) return { key, packageId: file.packageId, problem: 'duplicate', changes: [] };
    used.add(file.packageId);
    if (!file.submodel) return { key, packageId: file.packageId, problem: 'no-submodel', changes: [] };
    const current = new Map(leavesOf(file.submodel.content).map((leaf) => [leaf.path, leaf.current]));
    const changes: RowPlan['changes'] = [];
    input.mapping.forEach((path, column) => {
      if (!path || column === input.keyColumn) return;
      const after = (row[column] ?? '').trim();
      const before = current.get(path);
      if (after === '' || before === undefined || before === after) return;
      changes.push({ path, before, after });
    });
    return { key, packageId: file.packageId, changes };
  });
}
