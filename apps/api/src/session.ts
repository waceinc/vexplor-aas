/**
 * Login sessions — kept **in server memory**.
 *
 * Important: why not in the store (DB): there are three implementations (memory, folder, postgres), so persisting sessions
 *    would mean touching all three, while this tool assumes **a single server** (the installed edition is a single PC).
 *    Restarting the server means logging in again — a price worth paying in an air-gapped factory.
 *    When the time comes to scale to multiple servers, move this to the store then (this is the only place to change).
 *
 * Important: the cookie does not hold the user id. It holds only an **unguessable key**, looked up in a table the server keeps.
 *    With signed cookies (JWT etc.), logout and forced lockout would not take effect immediately.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { tr } from '@aas/core';

export interface Session {
  userId: string;
  createdAt: number;
  /** Last time used — idle time is counted from this moment */
  seenAt: number;
  /**
   * A name unique to this login — becomes the demo account's **workspace key** (2026-10-04).
   *
   * The demo account is a single account shared by many, so partitioning by account puts everyone in one slot.
   * Giving one per login means people entering with the same account cannot see each other's files.
   * Important: the session key itself is not used — that value is a secret carried in the cookie, while the workspace key
   *    is written to the DB. It is generated separately so the secret is not copied into the store.
   */
  visitor: string;
}

/** Disconnect after this much time with no activity */
const IDLE_MS = 8 * 60 * 60 * 1000; // 8 hours — one workday
/** Log in again after this much time no matter how much it is used */
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** New session. The returned key goes into the cookie */
  create(userId: string): string {
    this.sweep();
    // 32 bytes (256 bits) — cannot be guessed
    const key = randomBytes(32).toString('base64url');
    const at = this.now();
    this.sessions.set(key, { userId, createdAt: at, seenAt: at, visitor: randomBytes(12).toString('hex') });
    return key;
  }

  /**
   * Look up by key. If alive, refresh `seenAt` (it does not expire while in use).
   * Important: the comparison is done by the Map — the key is a 256-bit random value, so timing analysis cannot guess it.
   *    (A short human-chosen value like a token would need timingSafeEqual, but not here)
   */
  get(key: string | undefined): Session | undefined {
    if (!key) return undefined;
    const found = this.sessions.get(key);
    if (!found) return undefined;
    const at = this.now();
    if (at - found.seenAt > IDLE_MS || at - found.createdAt > ABSOLUTE_MS) {
      this.sessions.delete(key);
      return undefined;
    }
    found.seenAt = at;
    return found;
  }

  drop(key: string | undefined): void {
    if (key) this.sessions.delete(key);
  }

  /** Drop all of that person's sessions — when locked or the password changed */
  dropUser(userId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(key);
    }
  }

  /** Clear expired ones — once each time a session is created. No separate timer */
  private sweep(): void {
    const at = this.now();
    for (const [key, session] of this.sessions) {
      if (at - session.seenAt > IDLE_MS || at - session.createdAt > ABSOLUTE_MS) {
        this.sessions.delete(key);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * Login attempt limit — briefly blocks repeated failures with the same login name.
 *
 * Important: counts **by login name, not IP**. Inside a factory everything is often behind one NAT with the same IP,
 *    so counting by IP would block everyone when one person makes mistakes.
 * Important: even when blocked, it does not reveal "that account exists" — the response is the same "could not log in".
 */
export class LoginThrottle {
  /** "This account x this address" — slows down one person guessing passwords */
  private readonly fails = new Map<string, { count: number; until: number }>();
  /** "This account" overall — guessing while rotating addresses still stops eventually */
  private readonly perLogin = new Map<string, { count: number; until: number }>();

  /**
   * Important: previously only **the account name** was counted (2026-10-06 security review). That let anyone fail
   *    five times with someone else's id and lock them out for 5 minutes each — on the public demo server anyone could lock
   *    the demo account (admin) and block every visitor. So we count by "account x address", and the account as a whole
   *    only gets a much higher cap (against guessing while rotating addresses).
   */
  constructor(
    private readonly now: () => number = () => Date.now(),
    /** After this many failures from one address */
    private readonly limit = 5,
    /** block for this long */
    private readonly blockMs = 5 * 60 * 1000,
    /** After this many failures on one account regardless of address (guessing attack) */
    private readonly loginLimit = 50,
    private readonly loginBlockMs = 15 * 60 * 1000,
    /** Fixed delay added to every try on an account past `loginLimit` (see slowdownMs) */
    private readonly slowMs = 2000,
  ) {}

  private static active(
    map: Map<string, { count: number; until: number }>,
    key: string,
    at: number,
  ): { count: number; until: number } | undefined {
    const found = map.get(key);
    if (found && at >= found.until) {
      map.delete(key);
      return undefined;
    }
    return found;
  }

  blocked(login: string, address = ''): boolean {
    const name = login.toLowerCase();
    const at = this.now();
    const mine = LoginThrottle.active(this.fails, `${name}|${address}`, at);
    return (mine?.count ?? 0) >= this.limit;
  }

  /**
   * Delay before checking a password for this account, in ms — 0 normally, `slowMs` once the account has had
   * `loginLimit` failures from any mix of addresses.
   *
   * Important: this used to be a hard block (red-team L1, 2026-10-16). An attacker rotating spoofed addresses could fail
   *    50 times and lock the real owner out **from everywhere** for 15 minutes — a targeted lockout of the admin.
   *    A fixed delay still makes guessing slow (and the hash gate caps parallel tries), but the owner gets in.
   */
  slowdownMs(login: string): number {
    const all = LoginThrottle.active(this.perLogin, login.toLowerCase(), this.now());
    return (all?.count ?? 0) >= this.loginLimit ? this.slowMs : 0;
  }

  fail(login: string, address = ''): void {
    const name = login.toLowerCase();
    const at = this.now();
    for (const [map, key, ms] of [
      [this.fails, `${name}|${address}`, this.blockMs],
      [this.perLogin, name, this.loginBlockMs],
    ] as const) {
      const found = LoginThrottle.active(map, key, at);
      map.set(key, { count: (found?.count ?? 0) + 1, until: at + ms });
    }
  }

  /**
   * A successful login. Clears this address's count and takes back the one attempt `fail` counted up front.
   * Important: the login route counts **before** hashing (red-team L4) — counting after let a parallel burst run all its
   *    hashes before the first failure was recorded. So a success must undo its own provisional count.
   */
  pass(login: string, address = ''): void {
    const name = login.toLowerCase();
    this.fails.delete(`${name}|${address}`);
    const all = LoginThrottle.active(this.perLogin, name, this.now());
    if (all && all.count > 0) all.count -= 1;
  }
}

/**
 * Signup rate limit — slows down bots hitting the public demo server (2026-10-04).
 *
 * Important: this blocks something different from the login limit (LoginThrottle). That one blocks guessing
 *    **one account's password**; this one blocks **thousands of accounts being created**. There is no account
 *    to use as a key yet, so it counts by client address.
 *
 * Important: a global cap is kept too. `X-Forwarded-For` can be spoofed, so per-address caps alone
 *    cannot stop bots. The global cap cannot be spoofed, but when it is reached **legitimate people are blocked too** —
 *    a value chosen on the view that endlessly created accounts are worse on a public server.
 *    Reaching the cap is recorded in the startup log, so the operator can turn it off with `AAS_SIGNUP=off`.
 */
export class SignupThrottle {
  /** Times signups happened (global) */
  private readonly all: number[] = [];
  /** Signup times per address */
  private readonly byAddress = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** Signups the whole server accepts per hour */
    private readonly globalLimit = 30,
    /** Signups accepted from one address per hour */
    private readonly addressLimit = 5,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  private fresh(times: number[]): number[] {
    const from = this.now() - this.windowMs;
    while (times.length > 0 && times[0]! < from) times.shift();
    return times;
  }

  /** A human-readable reason if blocked, otherwise undefined */
  blocked(address: string | undefined): string | undefined {
    if (this.fresh(this.all).length >= this.globalLimit) {
      return tr('지금은 가입을 받을 수 없습니다 — 잠시 뒤에 다시 시도하십시오.');
    }
    const mine = this.byAddress.get(address ?? '');
    if (mine && this.fresh(mine).length >= this.addressLimit) {
      return tr('같은 곳에서 가입을 너무 많이 시도했습니다 — 한 시간 뒤에 다시 시도하십시오.');
    }
    return undefined;
  }

  /** Counted when a signup **succeeds** — failures create no account, so no reason to count them */
  took(address: string | undefined): void {
    const at = this.now();
    this.all.push(at);
    const key = address ?? '';
    const mine = this.byAddress.get(key) ?? [];
    mine.push(at);
    this.byAddress.set(key, mine);
  }
}
