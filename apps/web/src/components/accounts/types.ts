/**
 * 계정 — 역할 · 한 가지 일을 하는 틀(act).
 * components/Accounts.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
export type Role = 'admin' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'editor', 'viewer'];
/** 한 가지 일을 하고, 되면 알린다 — 되면 true */
export type Act = (work: () => Promise<unknown>, done: string) => Promise<boolean>;
/** 역할의 화면 이름 */
export const roleLabel = (role: Role, t: (text: string) => string): string =>
  role === 'admin' ? t('관리자') : role === 'editor' ? t('편집자') : t('열람자');
