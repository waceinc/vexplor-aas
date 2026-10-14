/**
 * Composition tree — draft rows · open input row · naming rules · wording per process/equipment file.
 * Split out of components/HierarchyTree.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 */
import { tr } from '../../i18n.js';

export interface DraftNode {
  name: string;
  /** Line level (only for group) — company → line → process → equipment */
  line?: boolean;
  /** group = process/line (level without a file) · file = placed equipment file · planned = name only (file later) · unopened = file not opened */
  kind: 'group' | 'file' | 'planned' | 'unopened';
  packageId?: string;
  fileName?: string;
  /** How many of the same thing (type quantity). Not shown when 1 */
  count: number;
  /** Instead of ×n, separate files name_1…_n — when per-unit collection is the goal */
  split: boolean;
  children: DraftNode[];
}

/** The open input row — under which row (path) and what (kind) is being added */
export interface Adder {
  path: string[];
  /** line = line (only on the company row) · group = process (assembly) · asset = equipment (part) */
  kind: 'asset' | 'group' | 'line';
}

/**
 * Naming rules — the linter is stricter than the server (`^[A-Za-z][A-Za-z0-9_]*$`) (KOSMO-SME-1: 2 or more characters).
 * Blocking here by the linter's standard removes "created it, then got a violation". `HasPart_…` collides with relationship element names (AASd-022)
 */
export const NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9_]$/;
export function nodeNameOk(name: string, siblings: readonly string[]): boolean {
  return NODE_NAME_RE.test(name) && !name.startsWith('HasPart_') && !siblings.includes(name);
}

/**
 * Screen wording — a process file says "process → equipment", an equipment file (part composition BoM) says "assembly → part".
 * Important: the part composition panel was saying "+ process" and "+ equipment" — out of step with the summary's "+ part",
 *    which read as "why does a part have a process?" (review, 2026-09-09). The structure is the same; only the wording differs.
 */
export const TERMS = {
  composite: {
    group: tr('공정'),
    asset: tr('설비'),
    groupMark: tr('공정·라인 — 파일 없는 층'),
    groupPlaceholder: tr('공정 이름 — 예: WeldingProcess (Enter로 연달아)'),
    assetPlaceholder: tr('이름만 — 예: PressMachine2'),
    /** Line — the level between company and process. Absent in part composition (equipment) */
    line: tr('라인') as string | undefined,
    lineMark: tr('라인 — 공정을 묶는 층(회사 바로 밑)'),
    linePlaceholder: tr('라인 이름 — 예: BodyLine (Enter로 연달아)'),
    /** "Planned" / "file not opened" badge on equipment without a file — meaning equipment must have its own file */
    fileBadges: true,
  },
  equipment: {
    group: tr('조립체'),
    asset: tr('부품'),
    groupMark: tr('조립체·모듈 — 부품을 묶는 층'),
    groupPlaceholder: tr('조립체 이름 — 예: DriveUnit (Enter로 연달아)'),
    assetPlaceholder: tr('부품 이름 — 예: MainMotor'),
    line: undefined as string | undefined,
    lineMark: '',
    linePlaceholder: '',
    /** Parts usually have no file of their own — calling them "planned" or "file not opened" reads as if something is missing */
    fileBadges: false,
  },
} as const;

export type Terms = (typeof TERMS)[keyof typeof TERMS];

export const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
