/**
 * 구성 트리 — 초안 줄 · 열린 입력 줄 · 이름 규칙 · 공정/설비 파일별 낱말.
 * components/HierarchyTree.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { tr } from '../../i18n.js';

export interface DraftNode {
  name: string;
  /** group = 공정·라인(파일 없는 층) · file = 올려 둔 설비 파일 · planned = 이름만(파일은 나중에) · unopened = 파일이 안 열림 */
  kind: 'group' | 'file' | 'planned' | 'unopened';
  packageId?: string;
  fileName?: string;
  /** 같은 것이 몇 대인지(형식 수량). 1이면 표시하지 않는다 */
  count: number;
  /** ×n 대신 이름_1…_n 파일로 각각 — 대별 수집이 목적일 때 */
  split: boolean;
  children: DraftNode[];
}

/** 열려 있는 입력 줄 — 어느 줄 밑(path)에 무엇(kind)을 넣는 중인가 */
export interface Adder {
  path: string[];
  kind: 'asset' | 'group';
}

/**
 * 이름 규칙 — 서버(`^[A-Za-z][A-Za-z0-9_]*$`)보다 린터가 엄격하다(KOSMO-SME-1: 2자 이상).
 * 여기서 린터 기준으로 막아 "만들었는데 위반"을 없앤다. `HasPart_…`는 관계 요소 이름과 부딪힌다(AASd-022)
 */
export const NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9_]$/;
export function nodeNameOk(name: string, siblings: readonly string[]): boolean {
  return NODE_NAME_RE.test(name) && !name.startsWith('HasPart_') && !siblings.includes(name);
}

/**
 * 화면 낱말 — 공정 파일은 「공정 → 설비」, 설비 파일(부품 구성 BoM)은 「조립체 → 부품」.
 * 🔴 부품 구성 패널이 「＋ 공정」「＋ 설비」로 말하고 있었다 — 요약의 「＋ 부품」과 어긋나
 *    "부품에 공정이 왜 있나"가 됐다(2026-09-09 검토). 구조는 같고 낱말만 다르다.
 */
export const TERMS = {
  composite: {
    group: tr('공정'),
    asset: tr('설비'),
    groupMark: tr('공정·라인 — 파일 없는 층'),
    groupPlaceholder: tr('공정 이름 — 예: WeldingProcess (Enter로 연달아)'),
    assetPlaceholder: tr('이름만 — 예: PressMachine2'),
    /** 파일 없는 설비에 「예정」·「파일 안 열림」 배지 — 설비는 제 파일이 있어야 한다는 뜻 */
    fileBadges: true,
  },
  equipment: {
    group: tr('조립체'),
    asset: tr('부품'),
    groupMark: tr('조립체·모듈 — 부품을 묶는 층'),
    groupPlaceholder: tr('조립체 이름 — 예: DriveUnit (Enter로 연달아)'),
    assetPlaceholder: tr('부품 이름 — 예: MainMotor'),
    /** 부품은 대개 제 파일이 없다 — 「예정」「파일 안 열림」이라 하면 빠진 것처럼 읽힌다 */
    fileBadges: false,
  },
} as const;

export type Terms = (typeof TERMS)[keyof typeof TERMS];

export const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
