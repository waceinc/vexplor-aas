/**
 * Fill values from CSV — the computation part (no UI). Maps the columns of an equipment register (one row = one piece of equipment)
 * to the value items of a submodel, and precomputes, per row, what changes in which file and how. Saving is done by the UI (CsvFillDialog).
 *
 * Ports to CSV the digital-twin concepts of the "MES column → AAS path mapping table" and the 4-step import
 * (connect → table → preview + column mapping → import) (direct DB connections are left out because of the burden of storing credentials).
 * The mapping is guessed from names, but a person corrects it.
 * Empty cells do not clear values — an empty cell in the register means "unknown", not "none".
 */

export interface Leaf {
  /** Path of idShorts joined with dots */
  path: string;
  /** Human-readable name (parent › child) */
  label: string;
  current: string;
}

/** Value items of a submodel JSON (Property · MLP · Range) — descends into collections · Entities (lists are skipped because they are indexed by position) */
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

/** Pick a value item by column name — only when it equals the last idShort or the full path (similar names are not picked) */
export function suggestTarget(header: string, leaves: readonly Leaf[]): string | undefined {
  const want = norm(header);
  if (!want) return undefined;
  const byLast = leaves.filter((leaf) => norm(leaf.path.split('.').pop() ?? '') === want);
  if (byLast.length === 1) return byLast[0]!.path;
  return leaves.find((leaf) => norm(leaf.path) === want)?.path;
}

/** The column identifying the equipment — a column named that way if present, otherwise the first column */
export function guessKeyColumn(headers: readonly string[]): number {
  const index = headers.findIndex((header) => /^(name|assetname|idshort|asset|equipment|설비|설비명|설비이름|이름|장비|장비명)$/i.test(norm(header)));
  return index >= 0 ? index : 0;
}

export interface FileTarget {
  packageId: string;
  /** Names this file can be referred to by — AAS idShort · file name (without extension) */
  names: readonly string[];
  /** The chosen submodel (same idShort) — if missing, this file has nowhere to put the values */
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
  /** Target path per column — if empty, that column is not used */
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
