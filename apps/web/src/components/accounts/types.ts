/**
 * Accounts — roles · the frame for doing one task (act).
 * Split out of components/Accounts.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
export type Role = 'admin' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'editor', 'viewer'];
/** Does one task and reports when done — true when done */
export type Act = (work: () => Promise<unknown>, done: string) => Promise<boolean>;
/** Display name of the role */
export const roleLabel = (role: Role, t: (text: string) => string): string =>
  role === 'admin' ? t('관리자') : role === 'editor' ? t('편집자') : t('열람자');
