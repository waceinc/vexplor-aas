/**
 * Login, logout, my info — the door humans use.
 *
 * Important: **the session key travels only in a cookie.** Returning it in the body or a header would lead UI code to
 *    put it in localStorage, and from then on a single XSS steals it. Scripts cannot
 *    read an HttpOnly cookie.
 * Important: **login failures do not reveal the reason.** Distinguishing "no such account" from "wrong password"
 *    lets outsiders find out whether an account exists. The response is always the same.
 */
import type { AasStore, UserRole } from '@aas/store';
import { levelOfRole, type Principal } from '../auth.js';
import { ApiError, json, type ApiRequest } from '../http.js';
import { checkPasswordRule, decoyHash, hashPassword, verifyPassword } from '../password.js';
import { SignupThrottle, type LoginThrottle, type SessionStore } from '../session.js';
import type { Route } from '../router.js';
import { clientAddress, sameCode } from '../security.js';
import { tr } from '@aas/core';

export const SESSION_COOKIE = 'aas_session';

/** Extracts the session key from the request headers */
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
 * One cookie line.
 * Important: `Secure` is added only over HTTPS — on plain HTTP (internal network, installed build) a Secure cookie
 *    is not stored by the browser at all, so login fails.
 * Important: `SameSite=Strict` — the cookie is not sent on requests coming from other sites (CSRF defense).
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
   * Did this request arrive over HTTPS — decides whether to add a `Secure` cookie.
   *
   * Important: asked **per request.** The default setup is a plain-HTTP server behind a reverse proxy that handles HTTPS,
   *    so deciding once at startup is permanently wrong (that is exactly why `Secure` was
   *    never added — fixed 2026-10-02).
   * Important: the opposite mistake hurts more: adding `Secure` for someone who came in over plain HTTP makes
   *    the browser **drop** the cookie and login fails entirely. So we ask instead of guessing.
   */
  secureCookie: (request: ApiRequest) => boolean;
  /**
   * Whether machine API keys are configured.
   * Important: this is what the UI uses to decide **whether to show the login screen.** With no accounts and no tokens,
   *    auth is off (development, installed build), so the login screen must not show — there is no account to enter.
   */
  tokenAuth?: boolean;
  /**
   * **Setup code** asked for when creating the first admin. If given, `/auth/setup` succeeds only with that value
   * (or a full-access API key). Important: this prevents **anyone from becoming admin first** on an externally
   * reachable server — see security.ts for the full rationale.
   */
  setupCode?: string;
  /** Whether this request carries a full-access API key — usable in place of the setup code */
  hasFullKey?: (request: ApiRequest) => boolean;
  /**
   * Whether self-signup is allowed (`AAS_SIGNUP=on`). If omitted, it is **not allowed** —
   * Important: anyone creating accounts on an internal server must not happen. Enable only on public demo servers.
   */
  signup?: {
    role: UserRole;
    /**
     * Privacy policy URL (`AAS_PRIVACY_URL`).
     *
     * Important: **without it, contact details are not accepted at all.** Collecting personal data without a policy is
     *    a legal problem, and above all it means "collecting it without saying how it is used".
     *    This value's role is to make operators publish a policy first if they want to collect it.
     */
    privacyUrl?: string;
  };
  /** Signup rate limit — slows down bots on public demo servers */
  signupThrottle?: SignupThrottle;
  /**
   * Demo account — the login screen tells visitors "try it with this account".
   *
   * Important: the password is included in the response. On a public demo server it is **a value offered for anyone to use**,
   *    so the exposure is the same as printing it on the login screen. Included only when `DEMO_MODE=on`.
   */
  demo?: { login: string; password: string };
}

/** User shape sent outward — Important: never include passwordHash */
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
 * Shape of "the currently logged-in me" — including the contact details the account settings screen fills in.
 * Important: used **only where I ask about myself (GET · PATCH /auth/me).** Not included in login/signup responses —
 *    the UI has no use for it there, and there is no reason to multiply where responses linger (logs, caches).
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
   * Deletes an account — self-withdrawal and admin deletion do **the same thing**.
   *
   * Important: the person's uploaded files are deleted too (found 2026-10-06 while writing the privacy policy). Deleting only
   *    the account leaves ownerless files on the server — contradicting the promise to destroy data without delay on withdrawal,
   *    and equipment files contain company and drawing information. Owners are recorded only on servers that separate
   *    workspaces (demo, AAS_WORKSPACE=private) — files on a shared team server belong to the team, have no owner, and are not deleted.
   * Important: this store is the workspace layer. Admins see everything, users see their own — either way
   *    the person's files are visible. Still, only files whose owner matches are deleted (so shared files are not).
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
   * Important: **the demo account cannot modify itself.**
   *
   * It is shared by many people, so if one visitor changes the password or deletes the account,
   * **nobody can get into the demo server afterward.** It stays dead until the server is restarted.
   * A hole confirmed by actual testing (2026-10-04).
   */
  const refuseDemoAccount = (who: ApiRequest['principal']): void => {
    if (who && demoLogin !== undefined && who.login.toLowerCase() === demoLogin) {
      throw new ApiError(
        403,
        'Forbidden',
        tr('데모 계정은 바꾸거나 지울 수 없습니다 — 여럿이 함께 쓰는 계정입니다. 「회원가입」으로 자기 계정을 만드십시오.'),
      );
    }
  };
  /** Whether viewing as the demo account — before login (no account) also counts as demo (same rule as api.ts) */
  const demoNow = (login?: string): boolean =>
    demoLogin !== undefined && (login === undefined || login.toLowerCase() === demoLogin);

  return [
    {
      /**
       * Login state — the first thing the UI calls.
       * If there are no accounts at all, `setupNeeded` tells it to show **create first admin**.
       */
      method: 'GET',
      pattern: '/auth/me',
      async handle({ request }) {
        const count = await store.countUsers();
        // Having even one account means "this server is used with login"
        const authRequired = count > 0 || tokenAuth;
        const off = {
          authenticated: false,
          setupNeeded: count === 0,
          authRequired,
          // Whether creating the first admin requires the setup code — the UI shows one more field
          ...(count === 0 && setupCode !== undefined ? { setupCodeRequired: true } : {}),
          ...(signup ? { signupAllowed: true } : {}),
          ...(signup?.privacyUrl ? { privacyUrl: signup.privacyUrl } : {}),
          ...(options.demo ? { demo: { ...options.demo } } : {}),
        };
        const session = sessions.get(sessionKeyOf(request));
        if (!session) return json(200, off);
        const user = await store.getUser(session.userId);
        // The session is alive but the account is gone or locked — drop it
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
          // Report demo **only when the signed-in user is the demo account** — registered users have no restrictions
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
          throw new ApiError(400, 'BadRequest', tr('로그인 이름과 비밀번호를 모두 주십시오.'));
        }
        // Important: the demo account is not counted — its password is public on screen so there is nothing to protect,
        //    and counting would let anyone lock it with wrong passwords and block every visitor
        const counted = demoLogin === undefined || login.toLowerCase() !== demoLogin;
        const from = clientAddress(request) ?? '';
        // Important: even when blocked, do not reveal "that account exists" — the message is the same as below
        if (counted && throttle.blocked(login, from)) {
          throw new ApiError(
            429,
            'TooManyRequests',
            tr('로그인 시도가 많습니다. 5분 뒤에 다시 해 주십시오.'),
          );
        }

        if (counted) {
          // Important: an account under an address-rotating guessing attack is slowed down, not locked (session.ts L1)
          const wait = throttle.slowdownMs(login);
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          // Important: counted **before** the hash — a parallel burst must hit the cap while its hashes are still
          //    running, not after all of them ran (red-team L4). A success takes the count back (throttle.pass)
          throttle.fail(login, from);
        }

        const found = await store.findUserByLogin(login);
        const user = found && !found.disabled ? found : undefined;
        // Important: unknown and disabled accounts are checked against a decoy hash at the same cost — otherwise the
        //    response time says which logins exist (red-team M1)
        const ok = await verifyPassword(password, user?.passwordHash ?? (await decoyHash()));
        if (!ok || !user) {
          // Important: do not distinguish an existing account from a wrong password
          throw new ApiError(401, 'Unauthorized', tr('로그인하지 못했습니다 — 이름이나 비밀번호를 확인하십시오.'));
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
       * Self-signup — opened only on public demo servers (`AAS_SIGNUP=on`).
       *
       * Important: **this is different from creating the first admin.** Accounts may already exist, and the role is
       *    fixed to what the operator set (default editor) — signing up does not make you an admin.
       * Important: the password rule still applies. The demo account's `1234` is an exception the server seeds itself,
       *    and there is no reason to loosen the rule for accounts people create.
       */
      method: 'POST',
      pattern: '/auth/signup',
      success: [201],
      async handle({ request }) {
        if (!signup) {
          throw new ApiError(403, 'Forbidden', tr('이 서버는 가입을 받지 않습니다 — 관리자에게 계정을 받으십시오.'));
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
            tr('로그인 이름은 영문으로 시작하고 영문·숫자·_ . - 만 씁니다(2~41자).'),
          );
        }
        const bad = checkPasswordRule(password);
        if (bad) throw new ApiError(400, 'BadRequest', bad);
        // Important: a server without a published privacy policy **does not accept** personal data (email, company name).
        //    The point is not to collect data without stating how it is used, and it also nudges operators to publish
        //    a policy first (AAS_PRIVACY_URL)
        if (!signup.privacyUrl) {
          if (email !== '' || company !== '') {
            throw new ApiError(400, 'BadRequest', tr('이 서버는 연락처를 받지 않습니다 — 비워 두고 가입하십시오.'));
          }
        } else {
          // Server with a published policy (public demo server) — collects name, company, email and **consent** (2026-10-06)
          // Important: company name is **optional** (user request, 2026-10-08) — so individuals trying it out can sign up too
          if (displayName === '' || email === '') {
            throw new ApiError(400, 'BadRequest', tr('이름 · 이메일을 적어 주십시오.'));
          }
          if (displayName.length > 40 || company.length > 80 || email.length > 120) {
            throw new ApiError(400, 'BadRequest', tr('입력이 너무 깁니다.'));
          }
          // Only the format is checked. **It is not verified** — there is no mail server.
          // Faking it and letting people believe it is a "verified address" would be worse
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            throw new ApiError(400, 'BadRequest', tr('이메일 형식이 올바르지 않습니다.'));
          }
          // Important: nothing is accepted without consent — the server re-checks rather than trusting the UI checkbox
          if (!agreed) {
            throw new ApiError(400, 'BadRequest', tr('개인정보 수집·이용에 동의해야 가입할 수 있습니다.'));
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
            // Record the consent time by the server clock — it is evidence
            ...(signup.privacyUrl ? { consentAt: new Date().toISOString() } : {}),
          });
        } catch {
          // Important: "name already taken" is not hidden. Unlike login failures, here people
          //    cannot sign up unless told to pick another name
          throw new ApiError(409, 'Conflict', tr('이미 쓰이는 로그인 이름입니다 — 다른 이름을 고르십시오.'));
        }
        // Important: count only on success — failures create no account, so there is no reason to count them
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
       * Withdrawal — **deletes** your own account.
       *
       * Important: not faked by locking (disabled). Locking keeps the contact details, which does not honor a
       *    "delete me" request. It deletes, but **the audit log remains** — the "who" in history is a copy of the
       *    name at that time, not a reference to the users table (2026-10-02 design).
       * Important: the last admin cannot be deleted. Otherwise nobody could manage accounts.
       */
      method: 'DELETE',
      pattern: '/auth/me',
      success: [204],
      async handle({ request }) {
        const who = request.principal;
        if (!who) throw new ApiError(401, 'Unauthorized', tr('로그인이 필요합니다.'));
        refuseDemoAccount(who);
        if (who.role === 'admin') {
          const admins = (await store.listUsers()).filter((user) => user.role === 'admin' && !user.disabled);
          if (admins.length <= 1) {
            throw new ApiError(
              409,
              'Conflict',
              tr('마지막 관리자는 탈퇴할 수 없습니다 — 다른 관리자를 먼저 만드십시오.'),
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
        // Max-Age=0 — the browser deletes the cookie
        return { status: 204, headers: { 'set-cookie': cookieLine('', secureCookie(request), 0) }, body: undefined };
      },
    },
    {
      /**
       * Create the first admin — open **only when there are no accounts at all**.
       * Important: closed once an account exists. Otherwise anyone could create more admins.
       */
      method: 'POST',
      pattern: '/auth/setup',
      success: [201],
      async handle({ request }) {
        if ((await store.countUsers()) > 0) {
          throw new ApiError(409, 'Conflict', tr('이미 계정이 있습니다 — 관리자에게 받으십시오.'));
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        // Important: on an externally reachable server, only **someone with access to the server** creates the first admin.
        //    Otherwise anyone on the same network could call it first, become admin, and leave the operator stuck at 409
        if (setupCode !== undefined && !hasFullKey(request)) {
          const given = String(body['setupCode'] ?? '').trim();
          if (!given || !sameCode(setupCode, given)) {
            throw new ApiError(
              403,
              'Forbidden',
              tr('설치 코드가 필요합니다 — 서버를 띄운 화면(기동 로그)에 적혀 있습니다.'),
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
            tr('로그인 이름은 영문으로 시작하고 영문·숫자·_ . - 만 씁니다(2~41자).'),
          );
        }
        const bad = checkPasswordRule(password);
        if (bad) throw new ApiError(400, 'BadRequest', bad);

        // Important: the earlier count is only a fast answer. The hash takes tens of ms, so two setups racing each other
        //    both passed it — createFirstUser checks again and inserts in one step (red-team L3)
        const user = await store.createFirstUser({
          login,
          displayName,
          role: 'admin',
          passwordHash: await hashPassword(password),
        });
        if (!user) throw new ApiError(409, 'Conflict', tr('이미 계정이 있습니다 — 관리자에게 받으십시오.'));
        const key = sessions.create(user.id);
        return {
          status: 201,
          headers: { 'set-cookie': cookieLine(key, secureCookie(request)) },
          body: { user: publicUser(user) },
        };
      },
    },
    {
      /** Account list — used by the admin screen */
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
            // Important: contact details are visible **to admins only** (this route uses requireAdmin)
            ...(user.email ? { email: user.email } : {}),
            ...(user.company ? { company: user.company } : {}),
            ...(user.consentAt ? { consentAt: user.consentAt } : {}),
            // Demo account — tells the UI to hide delete/lock on that row (the server blocks it too)
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
            tr('로그인 이름은 영문으로 시작하고 영문·숫자·_ . - 만 씁니다(2~41자).'),
          );
        }
        if (!['admin', 'editor', 'viewer'].includes(role)) {
          throw new ApiError(400, 'BadRequest', tr('역할은 admin · editor · viewer 중 하나입니다.'));
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
       * Admin deletes an account (user request, 2026-10-06 — next to lock and password reset).
       *
       * Important: does the same as withdrawal — deletes the person's uploaded files too. Irreversible.
       *    To block without deleting, use "Lock".
       * Important: three things are refused: yourself (deleting it by mistake could lock everyone out — use withdrawal for your own) ·
       *    the last admin · the demo account (deleting it closes the door of the public server).
       */
      method: 'DELETE',
      pattern: '/auth/users/:userId',
      success: [200],
      async handle({ request, params }) {
        requireAdmin(request);
        // When called with an API key (machine) there is no person — the "yourself" check applies only to people
        const me = request.principal;
        const id = params['userId']!;
        const target = await store.getUser(id);
        if (!target) throw new ApiError(404, 'NotFound', tr('그런 계정이 없습니다.'));
        if (me && target.id === me.userId) {
          throw new ApiError(409, 'Conflict', tr('자기 계정은 여기서 지울 수 없습니다 — 「설정 → 탈퇴」를 쓰십시오.'));
        }
        if (demoLogin !== undefined && target.login.toLowerCase() === demoLogin) {
          throw new ApiError(403, 'Forbidden', tr('데모 계정은 지울 수 없습니다 — 지우면 공개 서버에 아무도 들어오지 못합니다.'));
        }
        if (target.role === 'admin') {
          const admins = (await store.listUsers()).filter((user) => user.role === 'admin' && !user.disabled);
          if (admins.length <= 1) {
            throw new ApiError(409, 'Conflict', tr('마지막 관리자는 지울 수 없습니다 — 다른 관리자를 먼저 만드십시오.'));
          }
        }
        const files = await removeAccount(id);
        return json(200, { deleted: id, files });
      },
    },
    {
      /**
       * Edit an account — role, name, lock, password reset.
       * Important: a change **drops that person's sessions.** Lowering a role is pointless if an already open window
       *    keeps editing.
       */
      method: 'PATCH',
      pattern: '/auth/users/:userId',
      async handle({ request, params }) {
        requireAdmin(request);
        const id = params['userId']!;
        const target = await store.getUser(id);
        if (!target) throw new ApiError(404, 'NotFound', tr('그런 계정이 없습니다.'));
        // Important: not even admins can change the demo account (2026-10-06 security review). Promoting it to admin would make
        //    **anyone** logging in with admin/1234 an admin, and changing its password or locking it closes the public server's door
        if (demoLogin !== undefined && target.login.toLowerCase() === demoLogin) {
          throw new ApiError(403, 'Forbidden', tr('데모 계정은 바꿀 수 없습니다 — 공개 서버의 입구입니다.'));
        }
        const body = (request.body ?? {}) as Record<string, unknown>;

        const patch: Parameters<AasStore['updateUser']>[1] = {};
        if (typeof body['displayName'] === 'string') patch.displayName = body['displayName'].trim();
        if (typeof body['role'] === 'string') {
          const role = body['role'] as UserRole;
          if (!['admin', 'editor', 'viewer'].includes(role)) {
            throw new ApiError(400, 'BadRequest', tr('역할은 admin · editor · viewer 중 하나입니다.'));
          }
          patch.role = role;
        }
        if (typeof body['disabled'] === 'boolean') patch.disabled = body['disabled'];
        if (typeof body['password'] === 'string' && body['password'] !== '') {
          const bad = checkPasswordRule(body['password']);
          if (bad) throw new ApiError(400, 'BadRequest', bad);
          patch.passwordHash = await hashPassword(body['password']);
        }

        // Important: locking or demoting the last admin means **nobody can manage accounts anymore.**
        //    The only way back would be editing the DB directly, so block it here.
        const losingAdmin =
          target.role === 'admin' && (patch.role !== undefined && patch.role !== 'admin' || patch.disabled === true);
        if (losingAdmin) {
          const admins = (await store.listUsers()).filter((u) => u.role === 'admin' && !u.disabled);
          if (admins.length <= 1) {
            throw new ApiError(
              409,
              'Conflict',
              tr('마지막 관리자입니다 — 다른 관리자를 먼저 만드십시오. 아무도 계정을 다룰 수 없게 됩니다.'),
            );
          }
        }

        const after = await store.updateUser(id, patch);
        if (!after) throw new ApiError(404, 'NotFound', tr('그런 계정이 없습니다.'));
        // If role, lock or password changed, drop that person's sessions
        if (patch.role !== undefined || patch.disabled !== undefined || patch.passwordHash !== undefined) {
          sessions.dropUser(id);
        }
        return json(200, { user: publicUser(after) });
      },
    },
    {
      /**
       * Edit my info — display name, company, email (2026-10-08, "My account settings").
       *
       * Important: login name and role cannot be changed here. The login name is a key tied to the audit log,
       *    and self-promotion of roles would break the permission model (admins change roles in "Account management").
       * Important: the demo account is refused — it is a shared public entrance.
       * An empty string means "clear it" (company, email). The display name cannot be empty.
       */
      method: 'PATCH',
      pattern: '/auth/me',
      async handle({ request }) {
        const who = request.principal;
        if (!who) throw new ApiError(401, 'Unauthorized', tr('로그인이 필요합니다.'));
        refuseDemoAccount(who);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const patch: { displayName?: string; email?: string; company?: string } = {};
        if (body['displayName'] !== undefined) {
          const displayName = String(body['displayName']).trim();
          if (displayName === '' || displayName.length > 40) {
            throw new ApiError(400, 'BadRequest', tr('표시 이름은 1~40자로 적어 주십시오.'));
          }
          patch.displayName = displayName;
        }
        if (body['email'] !== undefined) {
          const email = String(body['email']).trim();
          if (email.length > 120 || (email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
            throw new ApiError(400, 'BadRequest', tr('이메일 형식이 올바르지 않습니다.'));
          }
          patch.email = email;
        }
        if (body['company'] !== undefined) {
          const company = String(body['company']).trim();
          if (company.length > 80) throw new ApiError(400, 'BadRequest', tr('회사명이 너무 깁니다.'));
          patch.company = company;
        }
        if (Object.keys(patch).length === 0) throw new ApiError(400, 'BadRequest', tr('바꿀 내용이 없습니다.'));
        const updated = await store.updateUser(who.userId, patch);
        if (!updated) throw new ApiError(401, 'Unauthorized', tr('로그인이 필요합니다.'));
        return json(200, { user: selfUser(updated) });
      },
    },
    {
      /**
       * Change my password — requires the current password too.
       * Important: someone else may have a window open, so **all my other sessions are dropped** and only this window is re-opened.
       */
      method: 'POST',
      pattern: '/auth/password',
      async handle({ request }) {
        const who = request.principal;
        if (!who) throw new ApiError(401, 'Unauthorized', tr('로그인이 필요합니다.'));
        refuseDemoAccount(who);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const current = String(body['current'] ?? '');
        const next = String(body['next'] ?? '');
        const user = await store.getUser(who.userId);
        if (!user) throw new ApiError(401, 'Unauthorized', tr('로그인이 필요합니다.'));
        if (!(await verifyPassword(current, user.passwordHash))) {
          throw new ApiError(401, 'Unauthorized', tr('지금 비밀번호가 맞지 않습니다.'));
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
 * Admins only — otherwise refuse.
 *
 * Important: no `principal` means **a machine (API key) or a server with auth off.** A full-access key passes (its holder
 *    already has full access) and so does a server with auth off (no basis to block). A read-only key does not.
 *    (To turn auth on, create an account or configure a token)
 */
function requireAdmin(request: ApiRequest): void {
  const who = request.principal;
  if (who) {
    if (who.role !== 'admin') throw new ApiError(403, 'Forbidden', tr('관리자만 계정을 다룰 수 있습니다.'));
    return;
  }
  // Important: without a person, only a **full** API key or a truly open server (no keys, no accounts) passes.
  //    A read-only key used to pass because "no principal" was read as "machine with full access" (red-team M2)
  const access = request.access;
  if (access?.level === 'full' && (access.via === 'apikey' || access.via === 'open')) return;
  throw new ApiError(403, 'Forbidden', tr('관리자만 계정을 다룰 수 있습니다.'));
}

/** Resolves the person from the request's session. Returns undefined if none — then it is the token's turn */
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
