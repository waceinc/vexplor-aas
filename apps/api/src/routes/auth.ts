/**
 * 로그인·로그아웃·내 정보 — 사람이 쓰는 문.
 *
 * 🔴 **세션 열쇠는 쿠키로만 오간다.** 본문이나 헤더에 담아 돌려주면 화면 코드가 그것을
 *    localStorage에 넣게 되고, 그 순간 XSS 한 방에 털린다. HttpOnly 쿠키는 스크립트가
 *    읽지 못한다.
 * 🔴 **로그인 실패는 이유를 가리지 않는다.** "그런 계정 없음"과 "비밀번호 틀림"을 나누면
 *    계정이 있는지 없는지를 밖에서 알아낼 수 있다. 응답은 언제나 같다.
 */
import type { AasStore, UserRole } from '@aas/store';
import { levelOfRole, type Principal } from '../auth.js';
import { ApiError, json, type ApiRequest } from '../http.js';
import { checkPasswordRule, hashPassword, verifyPassword } from '../password.js';
import { SignupThrottle, type LoginThrottle, type SessionStore } from '../session.js';
import type { Route } from '../router.js';
import { clientAddress, sameCode } from '../security.js';

export const SESSION_COOKIE = 'aas_session';

/** 요청 헤더에서 세션 열쇠를 꺼낸다 */
export function sessionKeyOf(request: ApiRequest): string | undefined {
  const raw = request.headers['cookie'];
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * 쿠키 한 줄.
 * 🔴 `Secure`는 HTTPS일 때만 붙인다 — 평문 HTTP(사내망·설치판)에서 Secure를 붙이면
 *    브라우저가 쿠키를 아예 저장하지 않아 로그인이 안 된다.
 * 🔴 `SameSite=Strict` — 다른 사이트에서 건너온 요청에는 쿠키를 싣지 않는다(CSRF 방어).
 */
function cookieLine(key: string, secure: boolean, maxAgeSeconds?: number): string {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(key)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) bits.push('Secure');
  if (maxAgeSeconds !== undefined) bits.push(`Max-Age=${maxAgeSeconds}`);
  return bits.join('; ');
}

export interface AuthRouteOptions {
  sessions: SessionStore;
  throttle: LoginThrottle;
  /**
   * 이 요청이 HTTPS로 왔나 — `Secure` 쿠키를 붙일지 정한다.
   *
   * 🔴 **요청마다** 묻는다. 서버는 평문으로 뜨고 앞의 리버스 프록시가 HTTPS를 맡는
   *    구성이 기본이라, 기동 때 한 번 정해 두면 영영 틀린다(실제로 그래서 `Secure`가
   *    한 번도 붙지 않았다 — 2026-10-02에 바로잡음).
   * 🔴 반대 방향의 사고가 더 아프다: 평문으로 들어온 사람에게 `Secure`를 붙이면
   *    브라우저가 쿠키를 **버려서** 로그인이 아예 안 된다. 그래서 추측하지 않고 묻는다.
   */
  secureCookie: (request: ApiRequest) => boolean;
  /**
   * 기계용 API 키가 설정돼 있나.
   * 🔴 화면이 **로그인 화면을 띄울지** 정하는 근거다. 계정도 토큰도 없으면 인증이 꺼진
   *    서버(개발·설치판)이므로 로그인 화면을 띄우면 안 된다 — 넣을 계정이 없다.
   */
  tokenAuth?: boolean;
  /**
   * 첫 관리자 만들기에 물을 **설치 코드**. 주면 그 값(또는 전체 권한 API 키)이 있어야
   * `/auth/setup`이 통한다. 🔴 밖으로 열린 서버에서 **아무나 먼저 관리자가 되는 것**을
   * 막기 위한 것이다 — 자세한 사유는 security.ts.
   */
  setupCode?: string;
  /** 이 요청이 전체 권한 API 키를 들고 있나 — 설치 코드 대신 쓸 수 있다 */
  hasFullKey?: (request: ApiRequest) => boolean;
  /**
   * 스스로 가입할 수 있게 할지(`AAS_SIGNUP=on`). 주지 않으면 **못 한다** —
   * 🔴 사내망 서버에서 아무나 계정을 만들면 안 된다. 공개 체험 서버에서만 켠다.
   */
  signup?: {
    role: UserRole;
    /**
     * 개인정보처리방침 주소(`AAS_PRIVACY_URL`).
     *
     * 🔴 **없으면 연락처를 아예 받지 않는다.** 처리방침 없이 개인정보를 모으는 것은
     *    법적으로도 문제고, 무엇보다 「받아 놓고 어떻게 쓰는지 안 밝힌다」는 뜻이다.
     *    받고 싶으면 먼저 방침을 올려 두게 하는 것이 이 값의 역할이다.
     */
    privacyUrl?: string;
  };
  /** 가입 속도 제한 — 공개 체험 서버에 봇이 붙는 것을 늦춘다 */
  signupThrottle?: SignupThrottle;
  /**
   * 데모 계정 — 로그인 화면이 「이 계정으로 눌러 보십시오」라고 알려 준다.
   *
   * 🔴 비밀번호를 응답에 싣는다. 공개 체험 서버에서 **누구나 쓰라고 내놓은 값**이라
   *    로그인 화면에 적는 것과 노출이 같다. `DEMO_MODE=on`일 때만 실린다.
   */
  demo?: { login: string; password: string };
}

/** 밖으로 내보낼 사용자 모습 — 🔴 passwordHash는 절대 싣지 않는다 */
function publicUser(user: { id: string; login: string; displayName: string; role: UserRole }): {
  id: string;
  login: string;
  displayName: string;
  role: UserRole;
  level: ReturnType<typeof levelOfRole>;
} {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    role: user.role,
    level: levelOfRole(user.role),
  };
}

/**
 * 「지금 로그인한 나」의 모습 — 내 계정 설정 화면이 채워 보일 연락처까지.
 * 🔴 **나를 묻는 자리(GET · PATCH /auth/me)에만** 쓴다. 로그인·가입 응답에는 싣지 않는다 —
 *    거기서는 화면이 쓸 일이 없고, 응답이 남는 곳(로그·캐시)을 늘릴 이유가 없다.
 */
function selfUser(user: { id: string; login: string; displayName: string; role: UserRole; email?: string; company?: string }): ReturnType<typeof publicUser> & {
  email?: string;
  company?: string;
} {
  return {
    ...publicUser(user),
    ...(user.email ? { email: user.email } : {}),
    ...(user.company ? { company: user.company } : {}),
  };
}

export function buildAuthRoutes(store: AasStore, options: AuthRouteOptions): Route[] {
  const { sessions, throttle, secureCookie } = options;
  const tokenAuth = options.tokenAuth ?? false;
  const setupCode = options.setupCode;
  const hasFullKey = options.hasFullKey ?? ((): boolean => false);
  const signup = options.signup;
  const demoLogin = options.demo?.login.toLowerCase();
  const signupThrottle = options.signupThrottle ?? new SignupThrottle();

  /**
   * 계정을 지운다 — 탈퇴(본인)와 관리자 삭제가 **같은 일**을 한다.
   *
   * 🔴 그 사람이 올린 파일도 지운다(2026-10-06 처리방침을 쓰다가 찾았다). 계정만 지우면
   *    주인 없는 파일이 서버에 남는다 — 탈퇴하면 지체 없이 파기한다는 약속과 어긋나고,
   *    설비 파일에는 회사·도면 정보가 든다. 나누는 서버(체험판·AAS_WORKSPACE=private)에서만
   *    주인이 적힌다 — 팀 공용 서버의 파일은 팀 것이라 주인이 없고, 지우지 않는다.
   * 🔴 이 저장소는 작업 공간 겹이다. 관리자는 전부 보고, 본인은 자기 것을 본다 — 어느 쪽이든
   *    그 사람의 파일이 보인다. 그래도 주인이 맞는 것만 지운다(공용 파일을 지우지 않게).
   */
  const removeAccount = async (userId: string): Promise<number> => {
    const mine = `user:${userId}`;
    const owned: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listPackages(cursor === undefined ? { limit: 200 } : { limit: 200, cursor });
      for (const item of page.items) if (item.owner === mine) owned.push(item.id);
      cursor = page.cursor;
    } while (cursor !== undefined);
    for (const id of owned) await store.deletePackage(id);
    await store.deleteUser(userId);
    sessions.dropUser(userId);
    return owned.length;
  };

  /**
   * 🔴 **데모 계정은 자기 자신을 못 바꾼다.**
   *
   * 여럿이 같이 쓰는 계정이라, 방문자 하나가 비밀번호를 바꾸거나 계정을 지우면
   * **그 뒤로 아무도 체험 서버에 못 들어온다.** 서버를 다시 띄우기 전까지 죽는다.
   * 실측으로 확인한 구멍이다(2026-10-04).
   */
  const refuseDemoAccount = (who: ApiRequest['principal']): void => {
    if (who && demoLogin !== undefined && who.login.toLowerCase() === demoLogin) {
      throw new ApiError(
        403,
        'Forbidden',
        '데모 계정은 바꾸거나 지울 수 없습니다 — 여럿이 함께 쓰는 계정입니다. 「회원가입」으로 자기 계정을 만드십시오.',
      );
    }
  };
  /** 데모 계정으로 보고 있나 — 로그인 전(계정 없음)도 체험으로 본다(api.ts와 같은 기준) */
  const demoNow = (login?: string): boolean =>
    demoLogin !== undefined && (login === undefined || login.toLowerCase() === demoLogin);

  return [
    {
      /**
       * 로그인 상태 — 화면이 가장 먼저 부른다.
       * 계정이 하나도 없으면 `setupNeeded`로 **첫 관리자 만들기**를 띄우라고 알린다.
       */
      method: 'GET',
      pattern: '/auth/me',
      async handle({ request }) {
        const count = await store.countUsers();
        // 계정이 하나라도 있으면 "이 서버는 로그인으로 쓴다"는 뜻이다
        const authRequired = count > 0 || tokenAuth;
        const off = {
          authenticated: false,
          setupNeeded: count === 0,
          authRequired,
          // 첫 관리자를 만들 때 설치 코드를 물어야 하나 — 화면이 칸을 하나 더 보인다
          ...(count === 0 && setupCode !== undefined ? { setupCodeRequired: true } : {}),
          ...(signup ? { signupAllowed: true } : {}),
          ...(signup?.privacyUrl ? { privacyUrl: signup.privacyUrl } : {}),
          ...(options.demo ? { demo: { ...options.demo } } : {}),
        };
        const session = sessions.get(sessionKeyOf(request));
        if (!session) return json(200, off);
        const user = await store.getUser(session.userId);
        // 세션은 살아 있는데 계정이 사라졌거나 잠겼다 — 끊는다
        if (!user || user.disabled) {
          sessions.drop(sessionKeyOf(request));
          return json(200, off);
        }
        return json(200, {
          authenticated: true,
          setupNeeded: false,
          authRequired,
          ...(signup ? { signupAllowed: true } : {}),
          ...(signup?.privacyUrl ? { privacyUrl: signup.privacyUrl } : {}),
          // 들어와 있는 사람이 **데모 계정일 때만** 체험이라고 말한다 — 가입한 사람은 제한이 없다
          ...(demoNow(user.login) && options.demo ? { demo: { ...options.demo } } : {}),
          user: selfUser(user),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/auth/login',
      success: [200],
      async handle({ request }) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const login = String(body['login'] ?? '').trim();
        const password = String(body['password'] ?? '');
        if (login === '' || password === '') {
          throw new ApiError(400, 'BadRequest', '로그인 이름과 비밀번호를 모두 주십시오.');
        }
        // 🔴 데모 계정은 세지 않는다 — 비밀번호가 화면에 공개돼 있어 지킬 것이 없고,
        //    세면 누구나 틀린 비밀번호로 데모 계정을 잠가 모든 방문자를 막을 수 있다
        const counted = demoLogin === undefined || login.toLowerCase() !== demoLogin;
        const from = clientAddress(request) ?? '';
        // 🔴 막혀 있어도 "그 계정이 있다"를 알려 주지 않는다 — 문구가 아래와 같다
        if (counted && throttle.blocked(login, from)) {
          throw new ApiError(
            429,
            'TooManyRequests',
            '로그인 시도가 많습니다. 5분 뒤에 다시 해 주십시오.',
          );
        }

        const user = await store.findUserByLogin(login);
        const ok = user && !user.disabled && (await verifyPassword(password, user.passwordHash));
        if (!ok || !user) {
          if (counted) throttle.fail(login, from);
          // 🔴 있는 계정인지 비밀번호가 틀린 것인지 가르지 않는다
          throw new ApiError(401, 'Unauthorized', '로그인하지 못했습니다 — 이름이나 비밀번호를 확인하십시오.');
        }

        if (counted) throttle.pass(login, from);
        await store.touchUserLogin(user.id);
        const key = sessions.create(user.id);
        return {
          status: 200,
          headers: { 'set-cookie': cookieLine(key, secureCookie(request)) },
          body: { user: publicUser(user) },
        };
      },
    },
    {
      /**
       * 스스로 가입하기 — 공개 체험 서버에서만 연다(`AAS_SIGNUP=on`).
       *
       * 🔴 **첫 관리자 만들기와 다르다.** 이쪽은 계정이 이미 있어도 되고, 역할은
       *    운영자가 정한 것(기본 editor)으로 고정된다 — 가입한다고 관리자가 되지 않는다.
       * 🔴 비밀번호 규칙은 그대로 받는다. 데모 계정의 `1234`는 서버가 직접 심은
       *    예외이고, 사람이 만드는 계정까지 느슨하게 할 이유는 없다.
       */
      method: 'POST',
      pattern: '/auth/signup',
      success: [201],
      async handle({ request }) {
        if (!signup) {
          throw new ApiError(403, 'Forbidden', '이 서버는 가입을 받지 않습니다 — 관리자에게 계정을 받으십시오.');
        }
        const address = clientAddress(request);
        const tooMany = signupThrottle.blocked(address);
        if (tooMany) throw new ApiError(429, 'TooManyRequests', tooMany);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const login = String(body['login'] ?? '').trim();
        const password = String(body['password'] ?? '');
        const displayName = String(body['displayName'] ?? '').trim();
        const email = String(body['email'] ?? '').trim();
        const company = String(body['company'] ?? '').trim();
        const agreed = body['agreed'] === true;
        if (!/^[A-Za-z][A-Za-z0-9_.-]{1,40}$/.test(login)) {
          throw new ApiError(
            400,
            'BadRequest',
            '로그인 이름은 영문으로 시작하고 영문·숫자·_ . - 만 씁니다(2~41자).',
          );
        }
        const bad = checkPasswordRule(password);
        if (bad) throw new ApiError(400, 'BadRequest', bad);
        // 🔴 처리방침을 올려 두지 않은 서버는 개인정보(이메일·회사명)를 **받지 않는다.**
        //    어떻게 쓰는지 밝히지 않고 모으지 않겠다는 뜻이고, 운영자가 방침을 먼저
        //    올리게 만드는 장치이기도 하다(AAS_PRIVACY_URL)
        if (!signup.privacyUrl) {
          if (email !== '' || company !== '') {
            throw new ApiError(400, 'BadRequest', '이 서버는 연락처를 받지 않습니다 — 비워 두고 가입하십시오.');
          }
        } else {
          // 처리방침을 올린 서버(공개 체험 서버) — 이름 · 회사명 · 이메일과 **동의**를 받는다(2026-10-06)
          // 🔴 회사명은 **선택**이다(2026-10-08 사용자 요청) — 개인으로 써 보는 사람도 가입할 수 있게
          if (displayName === '' || email === '') {
            throw new ApiError(400, 'BadRequest', '이름 · 이메일을 적어 주십시오.');
          }
          if (displayName.length > 40 || company.length > 80 || email.length > 120) {
            throw new ApiError(400, 'BadRequest', '입력이 너무 깁니다.');
          }
          // 모양만 본다. **확인하지는 않는다** — 메일 서버가 없다.
          // 흉내만 내고 「확인된 주소」라고 믿게 만드는 쪽이 더 나쁘다
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            throw new ApiError(400, 'BadRequest', '이메일 형식이 올바르지 않습니다.');
          }
          // 🔴 동의 없이는 받지 않는다 — 화면의 체크만 믿지 않고 서버가 다시 본다
          if (!agreed) {
            throw new ApiError(400, 'BadRequest', '개인정보 수집·이용에 동의해야 가입할 수 있습니다.');
          }
        }

        let user;
        try {
          user = await store.createUser({
            login,
            displayName,
            role: signup.role,
            passwordHash: await hashPassword(password),
            ...(email === '' ? {} : { email }),
            ...(company === '' ? {} : { company }),
            // 동의한 때를 서버 시계로 적는다 — 증빙이다
            ...(signup.privacyUrl ? { consentAt: new Date().toISOString() } : {}),
          });
        } catch {
          // 🔴 「이미 있는 이름」은 숨기지 않는다. 로그인 실패와 달리 여기서는
          //    다른 이름을 고르라고 알려 주지 않으면 사람이 가입을 못 한다
          throw new ApiError(409, 'Conflict', '이미 쓰이는 로그인 이름입니다 — 다른 이름을 고르십시오.');
        }
        // 🔴 성공했을 때만 센다 — 실패는 계정을 만들지 않으니 셀 이유가 없다
        signupThrottle.took(address);
        const key = sessions.create(user.id);
        return {
          status: 201,
          headers: { 'set-cookie': cookieLine(key, secureCookie(request)) },
          body: { user: publicUser(user) },
        };
      },
    },
    {
      /**
       * 탈퇴 — 자기 계정을 **지운다**.
       *
       * 🔴 잠그기(disabled)로 때우지 않는다. 잠그면 연락처가 그대로 남아, 「지워 달라」는
       *    요구에 응한 것이 아니다. 지우되 **감사 기록은 남는다** — 이력의 「누가」는
       *    사람 표를 참조하지 않고 그때의 이름을 베껴 둔 값이다(2026-10-02 설계).
       * 🔴 마지막 관리자는 못 지운다. 지우면 아무도 계정을 관리하지 못한다.
       */
      method: 'DELETE',
      pattern: '/auth/me',
      success: [204],
      async handle({ request }) {
        const who = request.principal;
        if (!who) throw new ApiError(401, 'Unauthorized', '로그인이 필요합니다.');
        refuseDemoAccount(who);
        if (who.role === 'admin') {
          const admins = (await store.listUsers()).filter((user) => user.role === 'admin' && !user.disabled);
          if (admins.length <= 1) {
            throw new ApiError(
              409,
              'Conflict',
              '마지막 관리자는 탈퇴할 수 없습니다 — 다른 관리자를 먼저 만드십시오.',
            );
          }
        }
        await removeAccount(who.userId);
        return { status: 204, headers: { 'set-cookie': cookieLine('', secureCookie(request), 0) }, body: undefined };
      },
    },
    {
      method: 'POST',
      pattern: '/auth/logout',
      success: [204],
      async handle({ request }) {
        sessions.drop(sessionKeyOf(request));
        // Max-Age=0 — 브라우저가 쿠키를 지운다
        return { status: 204, headers: { 'set-cookie': cookieLine('', secureCookie(request), 0) }, body: undefined };
      },
    },
    {
      /**
       * 첫 관리자 만들기 — 계정이 **하나도 없을 때만** 열린다.
       * 🔴 계정이 생긴 뒤에는 닫힌다. 안 그러면 누구나 관리자를 더 만들 수 있다.
       */
      method: 'POST',
      pattern: '/auth/setup',
      success: [201],
      async handle({ request }) {
        if ((await store.countUsers()) > 0) {
          throw new ApiError(409, 'Conflict', '이미 계정이 있습니다 — 관리자에게 받으십시오.');
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        // 🔴 밖으로 열린 서버에서는 **서버를 만질 수 있는 사람**만 첫 관리자를 만든다.
        //    없으면 같은 망의 아무나 먼저 불러 관리자가 되고 운영자가 409로 막힌다
        if (setupCode !== undefined && !hasFullKey(request)) {
          const given = String(body['setupCode'] ?? '').trim();
          if (!given || !sameCode(setupCode, given)) {
            throw new ApiError(
              403,
              'Forbidden',
              '설치 코드가 필요합니다 — 서버를 띄운 화면(기동 로그)에 적혀 있습니다.',
            );
          }
        }
        const login = String(body['login'] ?? '').trim();
        const password = String(body['password'] ?? '');
        const displayName = String(body['displayName'] ?? '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_.-]{1,40}$/.test(login)) {
          throw new ApiError(
            400,
            'BadRequest',
            '로그인 이름은 영문으로 시작하고 영문·숫자·_ . - 만 씁니다(2~41자).',
          );
        }
        const bad = checkPasswordRule(password);
        if (bad) throw new ApiError(400, 'BadRequest', bad);

        const user = await store.createUser({
          login,
          displayName,
          role: 'admin',
          passwordHash: await hashPassword(password),
        });
        const key = sessions.create(user.id);
        return {
          status: 201,
          headers: { 'set-cookie': cookieLine(key, secureCookie(request)) },
          body: { user: publicUser(user) },
        };
      },
    },
    {
      /** 계정 목록 — 관리자 화면이 쓴다 */
      method: 'GET',
      pattern: '/auth/users',
      async handle({ request }) {
        requireAdmin(request);
        const users = await store.listUsers();
        return json(200, {
          result: users.map((user) => ({
            ...publicUser(user),
            disabled: user.disabled,
            createdAt: user.createdAt,
            ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
            // 🔴 연락처는 **관리자에게만** 보인다(이 경로가 requireAdmin이다)
            ...(user.email ? { email: user.email } : {}),
            ...(user.company ? { company: user.company } : {}),
            ...(user.consentAt ? { consentAt: user.consentAt } : {}),
            // 데모 계정 — 화면이 그 줄에서 지우기·잠그기를 빼게 알린다(서버도 막는다)
            ...(demoLogin !== undefined && user.login.toLowerCase() === demoLogin ? { demo: true } : {}),
          })),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/auth/users',
      success: [201],
      async handle({ request }) {
        requireAdmin(request);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const login = String(body['login'] ?? '').trim();
        const password = String(body['password'] ?? '');
        const role = String(body['role'] ?? 'editor') as UserRole;
        if (!/^[A-Za-z][A-Za-z0-9_.-]{1,40}$/.test(login)) {
          throw new ApiError(
            400,
            'BadRequest',
            '로그인 이름은 영문으로 시작하고 영문·숫자·_ . - 만 씁니다(2~41자).',
          );
        }
        if (!['admin', 'editor', 'viewer'].includes(role)) {
          throw new ApiError(400, 'BadRequest', '역할은 admin · editor · viewer 중 하나입니다.');
        }
        const bad = checkPasswordRule(password);
        if (bad) throw new ApiError(400, 'BadRequest', bad);
        try {
          const made = await store.createUser({
            login,
            displayName: String(body['displayName'] ?? '').trim(),
            role,
            passwordHash: await hashPassword(password),
          });
          return json(201, { user: publicUser(made) });
        } catch (caught) {
          throw new ApiError(409, 'Conflict', (caught as Error).message);
        }
      },
    },
    {
      /**
       * 관리자가 계정을 지운다(2026-10-06 사용자 요청 — 잠그기 · 비밀번호 초기화 옆에).
       *
       * 🔴 탈퇴와 같은 일을 한다 — 그 사람이 올린 파일까지 지운다. 되돌릴 수 없다.
       *    지우지 않고 막기만 하려면 「잠그기」를 쓴다.
       * 🔴 막는 것 셋: 나 자신(실수로 지우면 아무도 못 들어온다 — 내 것은 탈퇴로) ·
       *    마지막 관리자 · 데모 계정(지우면 공개 서버의 문이 닫힌다).
       */
      method: 'DELETE',
      pattern: '/auth/users/:userId',
      success: [200],
      async handle({ request, params }) {
        requireAdmin(request);
        // API 키(기계)로 부를 때는 사람이 없다 — 「나 자신」 검사는 사람일 때만
        const me = request.principal;
        const id = params['userId']!;
        const target = await store.getUser(id);
        if (!target) throw new ApiError(404, 'NotFound', '그런 계정이 없습니다.');
        if (me && target.id === me.userId) {
          throw new ApiError(409, 'Conflict', '자기 계정은 여기서 지울 수 없습니다 — 「설정 → 탈퇴」를 쓰십시오.');
        }
        if (demoLogin !== undefined && target.login.toLowerCase() === demoLogin) {
          throw new ApiError(403, 'Forbidden', '데모 계정은 지울 수 없습니다 — 지우면 공개 서버에 아무도 들어오지 못합니다.');
        }
        if (target.role === 'admin') {
          const admins = (await store.listUsers()).filter((user) => user.role === 'admin' && !user.disabled);
          if (admins.length <= 1) {
            throw new ApiError(409, 'Conflict', '마지막 관리자는 지울 수 없습니다 — 다른 관리자를 먼저 만드십시오.');
          }
        }
        const files = await removeAccount(id);
        return json(200, { deleted: id, files });
      },
    },
    {
      /**
       * 계정 고치기 — 역할·이름·잠금·비밀번호 초기화.
       * 🔴 바꾸면 **그 사람의 세션을 끊는다.** 역할을 낮췄는데 열려 있던 창이 그대로
       *    편집하고 있으면 낮춘 의미가 없다.
       */
      method: 'PATCH',
      pattern: '/auth/users/:userId',
      async handle({ request, params }) {
        requireAdmin(request);
        const id = params['userId']!;
        const target = await store.getUser(id);
        if (!target) throw new ApiError(404, 'NotFound', '그런 계정이 없습니다.');
        // 🔴 데모 계정은 관리자도 바꾸지 못한다(2026-10-06 보안 점검). 역할을 관리자로 올리면
        //    admin/1234로 들어온 **누구나 관리자**가 되고, 비밀번호를 바꾸거나 잠그면 공개 서버의 문이 닫힌다
        if (demoLogin !== undefined && target.login.toLowerCase() === demoLogin) {
          throw new ApiError(403, 'Forbidden', '데모 계정은 바꿀 수 없습니다 — 공개 서버의 입구입니다.');
        }
        const body = (request.body ?? {}) as Record<string, unknown>;

        const patch: Parameters<AasStore['updateUser']>[1] = {};
        if (typeof body['displayName'] === 'string') patch.displayName = body['displayName'].trim();
        if (typeof body['role'] === 'string') {
          const role = body['role'] as UserRole;
          if (!['admin', 'editor', 'viewer'].includes(role)) {
            throw new ApiError(400, 'BadRequest', '역할은 admin · editor · viewer 중 하나입니다.');
          }
          patch.role = role;
        }
        if (typeof body['disabled'] === 'boolean') patch.disabled = body['disabled'];
        if (typeof body['password'] === 'string' && body['password'] !== '') {
          const bad = checkPasswordRule(body['password']);
          if (bad) throw new ApiError(400, 'BadRequest', bad);
          patch.passwordHash = await hashPassword(body['password']);
        }

        // 🔴 마지막 관리자를 잠그거나 강등하면 **아무도 계정을 다룰 수 없게 된다.**
        //    되돌릴 길이 DB를 직접 고치는 것뿐이라 여기서 막는다.
        const losingAdmin =
          target.role === 'admin' && (patch.role !== undefined && patch.role !== 'admin' || patch.disabled === true);
        if (losingAdmin) {
          const admins = (await store.listUsers()).filter((u) => u.role === 'admin' && !u.disabled);
          if (admins.length <= 1) {
            throw new ApiError(
              409,
              'Conflict',
              '마지막 관리자입니다 — 다른 관리자를 먼저 만드십시오. 아무도 계정을 다룰 수 없게 됩니다.',
            );
          }
        }

        const after = await store.updateUser(id, patch);
        if (!after) throw new ApiError(404, 'NotFound', '그런 계정이 없습니다.');
        // 역할·잠금·비밀번호가 바뀌었으면 그 사람의 세션을 끊는다
        if (patch.role !== undefined || patch.disabled !== undefined || patch.passwordHash !== undefined) {
          sessions.dropUser(id);
        }
        return json(200, { user: publicUser(after) });
      },
    },
    {
      /**
       * 내 정보 고치기 — 표시 이름 · 회사명 · 이메일(2026-10-08 「내 계정 설정」).
       *
       * 🔴 로그인 이름과 역할은 여기서 못 바꾼다. 로그인 이름은 감사 기록과 맞물린 열쇠이고,
       *    역할을 스스로 올리면 권한 체계가 무너진다(역할은 관리자가 「계정 관리」에서).
       * 🔴 데모 계정은 거절한다 — 여럿이 쓰는 공용 입구다.
       * 빈 문자열은 「지우라」는 뜻이다(회사명 · 이메일). 표시 이름은 비울 수 없다.
       */
      method: 'PATCH',
      pattern: '/auth/me',
      async handle({ request }) {
        const who = request.principal;
        if (!who) throw new ApiError(401, 'Unauthorized', '로그인이 필요합니다.');
        refuseDemoAccount(who);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const patch: { displayName?: string; email?: string; company?: string } = {};
        if (body['displayName'] !== undefined) {
          const displayName = String(body['displayName']).trim();
          if (displayName === '' || displayName.length > 40) {
            throw new ApiError(400, 'BadRequest', '표시 이름은 1~40자로 적어 주십시오.');
          }
          patch.displayName = displayName;
        }
        if (body['email'] !== undefined) {
          const email = String(body['email']).trim();
          if (email.length > 120 || (email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
            throw new ApiError(400, 'BadRequest', '이메일 형식이 올바르지 않습니다.');
          }
          patch.email = email;
        }
        if (body['company'] !== undefined) {
          const company = String(body['company']).trim();
          if (company.length > 80) throw new ApiError(400, 'BadRequest', '회사명이 너무 깁니다.');
          patch.company = company;
        }
        if (Object.keys(patch).length === 0) throw new ApiError(400, 'BadRequest', '바꿀 내용이 없습니다.');
        const updated = await store.updateUser(who.userId, patch);
        if (!updated) throw new ApiError(401, 'Unauthorized', '로그인이 필요합니다.');
        return json(200, { user: selfUser(updated) });
      },
    },
    {
      /**
       * 내 비밀번호 바꾸기 — 지금 비밀번호를 함께 받는다.
       * 🔴 남의 창이 열려 있을 수 있으니 **내 다른 세션도 전부 끊고** 이 창만 다시 연다.
       */
      method: 'POST',
      pattern: '/auth/password',
      async handle({ request }) {
        const who = request.principal;
        if (!who) throw new ApiError(401, 'Unauthorized', '로그인이 필요합니다.');
        refuseDemoAccount(who);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const current = String(body['current'] ?? '');
        const next = String(body['next'] ?? '');
        const user = await store.getUser(who.userId);
        if (!user) throw new ApiError(401, 'Unauthorized', '로그인이 필요합니다.');
        if (!(await verifyPassword(current, user.passwordHash))) {
          throw new ApiError(401, 'Unauthorized', '지금 비밀번호가 맞지 않습니다.');
        }
        const bad = checkPasswordRule(next);
        if (bad) throw new ApiError(400, 'BadRequest', bad);
        await store.updateUser(user.id, { passwordHash: await hashPassword(next) });
        sessions.dropUser(user.id);
        const key = sessions.create(user.id);
        return {
          status: 200,
          headers: { 'set-cookie': cookieLine(key, secureCookie(request)) },
          body: { user: publicUser(user) },
        };
      },
    },
  ];
}

/**
 * 관리자만 — 아니면 거절한다.
 *
 * 🔴 `principal`이 없으면 **기계(API 키)이거나 인증이 꺼진 서버**다. 둘 다 통과시킨다 —
 *    API 키를 쥔 쪽은 이미 전체 권한이고, 인증이 꺼졌으면 막을 근거가 없다.
 *    (인증을 켜고 싶으면 계정을 만들거나 토큰을 설정하는 것이 그 수단이다)
 */
function requireAdmin(request: ApiRequest): void {
  const who = request.principal;
  if (who && who.role !== 'admin') {
    throw new ApiError(403, 'Forbidden', '관리자만 계정을 다룰 수 있습니다.');
  }
}

/** 요청에 딸린 세션에서 사람을 풀어낸다. 없으면 undefined — 그러면 토큰 차례다 */
export async function principalOf(
  store: AasStore,
  sessions: SessionStore,
  request: ApiRequest,
): Promise<Principal | undefined> {
  const session = sessions.get(sessionKeyOf(request));
  if (!session) return undefined;
  const user = await store.getUser(session.userId);
  if (!user || user.disabled) return undefined;
  return {
    userId: user.id,
    login: user.login,
    role: user.role,
    displayName: user.displayName,
    visitor: session.visitor,
  };
}
