/**
 * 체험판(데모) — 누구나 눌러 볼 수 있게 공개해 두는 서버.
 *
 * 🔴 **기본은 꺼져 있다.** 켜는 것은 서버를 올리는 사람의 명시적 선택(`DEMO_MODE=on`)이고,
 *    내려받아 직접 돌리는 사람에게는 아무 제한이 없다. 오픈소스로 내놓는 프로그램에
 *    제한을 박아 두는 것은 뜻이 없다 — 소스가 공개돼 있으니 이 파일만 지우면 풀린다.
 *    제한이 실제로 서는 자리는 **우리가 띄운 서버 한 곳뿐**이고, 거기서의 목적도
 *    「약을 올려 가입시키기」가 아니라 **공개 모래밭을 운영하는 최소한의 안전장치**다.
 *
 * 체험 계정으로는 **파일을 내려받을 수 없다.** 가입해 자기 계정으로 들어오면 받을 수 있다.
 *
 * 🔴 체험 계정은 **여럿이 같이 쓰는 한 계정**이다. 그래서 작업 공간을 **로그인마다** 가른다 —
 *    같은 계정으로 들어와도 서로가 올린 파일을 보지 못한다(@aas/store scoped.ts · api.ts).
 *    처음에는 가르지 않고 「남이 봅니다」라고 적어만 두었는데, 설비 도면·운전 데이터가
 *    올라오는 도구에서 그것은 고지가 아니라 사고 예고였다(2026-10-04에 바로잡음).
 *
 *    방문자의 작업 공간은 **한동안 안 쓰면 지운다**(기본 60분). 이제 이유는 사생활이 아니라
 *    디스크다 — 떠난 방문자의 파일이 쌓이기만 한다. 가입한 사람의 파일은 지우지 않는다.
 */
import type { AasStore, UserRole } from '@aas/store';

import type { ApiResponse } from './http.js';

export interface DemoConfig {
  /** 체험 계정의 로그인 이름 — 이 계정으로 들어오면 내려받기가 막힌다 */
  login: string;
  /** 처음 한 번 계정을 만들 때 쓰는 비밀번호 */
  password: string;
  displayName: string;
  /** 체험 계정의 역할. 눌러 보는 것이 목적이라 고칠 수는 있어야 한다 */
  role: UserRole;
  /** 방문자가 이만큼(분) 손대지 않은 파일을 지운다. 0이면 안 지운다(쌓이기만 한다) */
  resetMinutes: number;
}

/**
 * 🔴 기본 비밀번호가 `1234`다. 이것이 위험하지 않은 **유일한 이유**는 체험 계정이
 *    내려받기도 계정 관리도 못 하고, 올린 것이 주기적으로 지워지는 모래밭 전용이기
 *    때문이다. `DEMO_MODE`를 켜지 않은 서버에는 이 계정이 **생기지 않는다.**
 */
const DEFAULTS = {
  login: 'admin',
  password: '1234',
  displayName: '체험 계정',
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
 * 이 응답이 **파일을 내보내는 것**인가.
 *
 * 🔴 경로 목록으로 막지 않는 이유: 내려받기 경로가 지금도 다섯 군데고(AASX·번들 ZIP·
 *    첨부·표 CSV·…) 앞으로 늘어난다. 한 군데만 빠뜨리면 막았다고 믿는 채로 새어 나간다.
 *    대신 **나가는 응답**을 본다 — 첨부로 내보내는 것은 전부 걸린다.
 *
 * 화면으로 보는 것은 막지 않는다. 검증 결과서는 `content-disposition`이 없어 그대로
 * 열린다 — 도구가 무엇을 해 주는지는 보여 줘야 체험이 성립한다.
 */
export function isFileDownload(response: ApiResponse): boolean {
  const disposition = response.headers['content-disposition'] ?? '';
  return disposition.toLowerCase().includes('attachment');
}

/** 체험 계정이 처음 들어올 수 있게 한 번 만들어 둔다. 이미 있으면 아무 것도 안 한다 */
export async function seedDemoUser(
  store: AasStore,
  demo: DemoConfig,
  hash: (password: string) => Promise<string>,
): Promise<'created' | 'exists'> {
  if (await store.findUserByLogin(demo.login)) return 'exists';
  // 🔴 저장소에 바로 넣는다 — API의 비밀번호 규칙(10자 이상)을 타면 `1234`가 거절된다.
  //    규칙을 느슨하게 고치는 쪽이 아니라 **이 자리만 예외**로 두는 쪽이 맞다
  await store.createUser({
    login: demo.login,
    displayName: demo.displayName,
    role: demo.role,
    passwordHash: await hash(demo.password),
  });
  return 'created';
}

/** 체험 방문자의 작업 공간 열쇠 머리 — api.ts의 workspaceOf와 같은 값이어야 한다 */
export const VISITOR_PREFIX = 'visitor:';

/**
 * 한동안 손대지 않은 **방문자의** 파일을 지우고, 지운 개수를 돌려준다.
 *
 * 🔴 **방문자 것만 지운다.** 처음에는 주기마다 전부 지웠는데, 그러면 가입한 사람의 파일도
 *    한 시간 뒤에 사라진다 — 「가입하면 내려받을 수 있다」고 해 놓고 받을 것을 지우는 꼴이다.
 *    주인 없는 것(템플릿)과 가입한 사람의 것은 건드리지 않는다.
 * 🔴 **시각이 아니라 「안 쓴 지 얼마」로 지운다.** 정각마다 지우면 59분에 올린 사람은
 *    1분 만에 잃는다. 마지막으로 고친 때부터 센다.
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
  // 다 훑은 **뒤에** 지운다 — 훑는 중에 지우면 쪽 번호가 밀려 건너뛰는 것이 생긴다
  for (const id of stale) await store.deletePackage(id);
  return stale.length;
}

/**
 * 방문자 파일 정리를 주기적으로 돌린다.
 *
 * 🔴 요청 밖에서 돈다 — 작업 공간 문맥이 없어 **모든 패키지를 본다**(서버 자신이다).
 *    그래서 넘기는 저장소는 감싸지 않은 것이어도, 감싼 것이어도 같다.
 */
export function startDemoReset(
  store: AasStore,
  minutes: number,
  log: (message: string) => void = () => undefined,
): { stop: () => void } {
  if (minutes <= 0) return { stop: () => undefined };
  // 기다리는 시간의 1/4마다 본다(최소 1분) — 「60분 안 쓰면」이 실제로는 60~75분이 된다
  const every = Math.max(1, Math.min(10, Math.floor(minutes / 4)));
  const timer = setInterval(() => {
    void sweepVisitorFiles(store, minutes)
      .then((removed) => {
        if (removed > 0) log(`체험 서버 정리 — ${minutes}분 넘게 안 쓴 방문자 파일 ${removed}개를 지웠습니다.`);
      })
      .catch((error: unknown) => {
        log(`체험 서버 정리 실패: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, every * 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
