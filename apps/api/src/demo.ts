/**
 * Trial (demo) mode — a server published so that anyone can try it out.
 *
 * Important: **off by default.** Turning it on is an explicit choice by whoever runs the server (`DEMO_MODE=on`);
 *    anyone who downloads and runs it themselves gets no restrictions at all. Hard-coding restrictions into a program
 *    released as open source is pointless — the source is public, so deleting this file lifts them.
 *    The only place the restrictions actually hold is **the one server we run**, and the purpose there is
 *    not "tease people into signing up" but **the minimum safeguard for operating a public sandbox**.
 *
 * The demo account **cannot download files.** Sign up and log in with your own account to download.
 *
 * Important: the demo account is **one account shared by many people**. So workspaces are separated **per login** —
 *    even under the same account, people cannot see each other's uploaded files (@aas/store scoped.ts · api.ts).
 *    At first we did not separate them and only noted "others can see this", but in a tool where equipment drawings
 *    and operating data get uploaded, that was not a notice but a forecast of an incident (fixed on 2026-10-04).
 *
 *    A visitor's workspace is **deleted after a period of inactivity** (60 minutes by default). The reason now is not privacy
 *    but disk space — files from departed visitors just keep piling up. Registered users' files are never deleted.
 */
import type { AasStore, UserRole } from '@aas/store';

import type { ApiResponse } from './http.js';
import { fill, tr } from '@aas/core';

export interface DemoConfig {
  /** Login name of the demo account — logging in with it blocks downloads */
  login: string;
  /** Password used once when the account is first created */
  password: string;
  displayName: string;
  /** Role of the demo account. The point is to try things out, so it must be able to edit */
  role: UserRole;
  /** Delete files a visitor has not touched for this many minutes. 0 means never delete (they just pile up) */
  resetMinutes: number;
}

/**
 * Important: the default password is `0629` (2026-10-08 — previously `1234`). The **only reason** this is not dangerous is that the demo account
 *    can neither download nor manage accounts, and is a sandbox-only account whose uploads are periodically wiped.
 *    On servers that do not turn on `DEMO_MODE`, this account is **never created.**
 */
const DEFAULTS = {
  // 2026-10-08 — previously admin. It read as "administrator" and got confused with the operator account
  login: 'demo',
  password: '0629',
  // i18n-ignore — a display name stored in the accounts table (data), so it must not change per request
  displayName: '데모 계정',
  role: 'editor' as UserRole,
  resetMinutes: 60,
};

export function demoFromEnv(env: Record<string, string | undefined>): DemoConfig | undefined {
  if (env['DEMO_MODE'] !== 'on') return undefined;
  const minutes = Number(env['AAS_DEMO_RESET_MINUTES']);
  return {
    login: (env['AAS_DEMO_LOGIN']?.trim() || DEFAULTS.login).toLowerCase(),
    password: env['AAS_DEMO_PASSWORD']?.trim() || DEFAULTS.password,
    displayName: env['AAS_DEMO_NAME']?.trim() || DEFAULTS.displayName,
    role: DEFAULTS.role,
    resetMinutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULTS.resetMinutes,
  };
}

/**
 * Is this response **exporting a file**?
 *
 * Important: why not block by a list of paths: there are already five download paths (AASX, bundle ZIP,
 *    attachments, table CSV, …) and more will come. Miss just one and it leaks while we believe it is blocked.
 *    Instead we inspect the **outgoing response** — anything sent out as an attachment is caught.
 *
 * Viewing on screen is not blocked. The verification report has no `content-disposition`, so it opens
 * as-is — the trial only works if it shows what the tool does.
 */
export function isFileDownload(response: ApiResponse): boolean {
  const disposition = response.headers['content-disposition'] ?? '';
  if (disposition.toLowerCase().includes('attachment')) return true;
  // Important: the Part 2 serialization route returns a whole AASX without a file name — it is still the package leaving
  return (response.headers['content-type'] ?? '').toLowerCase().startsWith(AASX_PACKAGE_TYPE);
}

/** Same value as AASX_MEDIA_TYPE in routes/packages.ts — not imported, to keep this module free of route code */
const AASX_PACKAGE_TYPE = 'application/asset-administration-shell-package';

/**
 * Create the demo account, and if it already exists, **bring it in line with the settings** (name, password).
 *
 * Important: previously we did nothing if it existed. Then even after changing the password in `.env`, the running server's
 *    account kept the old password, so the screen showed the new password but login failed (2026-10-08).
 *    The demo account cannot be changed even by an admin in the UI (auth.ts), so the settings are its only source of truth.
 */
export async function seedDemoUser(
  store: AasStore,
  demo: DemoConfig,
  hash: (password: string) => Promise<string>,
  verify?: (password: string, stored: string) => Promise<boolean>,
): Promise<'created' | 'exists' | 'updated'> {
  const found = await store.findUserByLogin(demo.login);
  if (found) {
    const patch: { displayName?: string; passwordHash?: string } = {};
    if (found.displayName !== demo.displayName) patch.displayName = demo.displayName;
    if (verify && !(await verify(demo.password, found.passwordHash))) patch.passwordHash = await hash(demo.password);
    if (Object.keys(patch).length === 0) return 'exists';
    await store.updateUser(found.id, patch);
    return 'updated';
  }
  // Important: insert directly into the store — going through the API's password rule (10+ characters) would reject `1234`.
  //    The right move is to make **this one spot an exception**, not to loosen the rule
  await store.createUser({
    login: demo.login,
    displayName: demo.displayName,
    role: demo.role,
    passwordHash: await hash(demo.password),
  });
  return 'created';
}

/** Workspace key prefix for trial visitors — must be the same value as workspaceOf in api.ts */
export const VISITOR_PREFIX = 'visitor:';

/**
 * Delete **visitors'** files left untouched for a while, and return the number deleted.
 *
 * Important: **delete visitors' files only.** At first we wiped everything every cycle, but then registered users' files
 *    also vanished an hour later — saying "sign up and you can download" and then deleting what they would download.
 *    Ownerless items (templates) and registered users' files are left alone.
 * Important: **delete by "time since last use", not by clock time.** Wiping on the hour means someone who uploaded at :59
 *    loses it a minute later. We count from the last modification.
 */
export async function sweepVisitorFiles(store: AasStore, idleMinutes: number, now: number = Date.now()): Promise<number> {
  if (idleMinutes <= 0) return 0;
  const cutoff = now - idleMinutes * 60_000;
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listPackages(cursor === undefined ? { limit: 200 } : { limit: 200, cursor });
    for (const item of page.items) {
      if (item.owner?.startsWith(VISITOR_PREFIX) && Date.parse(item.updatedAt) < cutoff) stale.push(item.id);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  // Delete **after** the full scan — deleting mid-scan shifts page numbers and some items get skipped
  for (const id of stale) await store.deletePackage(id);
  return stale.length;
}

/**
 * Run the visitor-file cleanup periodically.
 *
 * Important: runs outside any request — there is no workspace context, so it **sees every package** (it is the server itself).
 *    So the store passed in may be the unwrapped one or the wrapped one; it makes no difference.
 */
export function startDemoReset(
  store: AasStore,
  minutes: number,
  log: (message: string) => void = () => undefined,
): { stop: () => void } {
  if (minutes <= 0) return { stop: () => undefined };
  // Check every 1/4 of the wait time (minimum 1 minute) — "unused for 60 minutes" effectively becomes 60–75 minutes
  const every = Math.max(1, Math.min(10, Math.floor(minutes / 4)));
  const timer = setInterval(() => {
    void sweepVisitorFiles(store, minutes)
      .then((removed) => {
        if (removed > 0) log(fill(tr('체험 서버 정리 — {0}분 넘게 안 쓴 방문자 파일 {1}개를 지웠습니다.'), { 0: minutes, 1: removed }));
      })
      .catch((error: unknown) => {
        log(fill(tr('체험 서버 정리 실패: {0}'), { 0: error instanceof Error ? error.message : String(error) }));
      });
  }, every * 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
