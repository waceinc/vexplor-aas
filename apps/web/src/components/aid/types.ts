/**
 * 수집 연결 만들기 — 태그 한 줄.
 * components/AddAid.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
export interface TagRow {
  name: string;
  href: string;
  type: string;
}

export const EMPTY: TagRow = { name: '', href: '', type: 'float' };

