/**
 * 로그인 세션 — **서버 메모리에** 둔다.
 *
 * 🔴 저장소(DB)에 두지 않은 이유: 구현이 셋(memory·folder·postgres)이라 세션까지 영속시키면
 *    셋 다 손봐야 하는데, 이 도구는 **서버 한 대**가 전제다(설치판은 아예 한 PC).
 *    서버를 내리면 다시 로그인한다 — 폐쇄망 공장에서 치를 만한 값이다.
 *    여러 대로 늘릴 때가 오면 그때 저장소로 옮긴다(그 자리가 여기 한 곳뿐이다).
 *
 * 🔴 쿠키에 사용자 id를 담지 않는다. **추측 불가능한 열쇠**만 담고 서버가 들고 있는 표에서 찾는다.
 *    서명 쿠키(JWT 등)로 하면 로그아웃·강제 잠금이 즉시 먹지 않는다.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface Session {
  userId: string;
  createdAt: number;
  /** 마지막으로 쓴 때 — 이 시각부터 유휴 시간을 센다 */
  seenAt: number;
  /**
   * 이 로그인만의 이름 — 체험 계정의 **작업 공간 열쇠**가 된다(2026-10-04).
   *
   * 체험 계정은 여럿이 같이 쓰는 한 계정이라, 계정으로 가르면 모두가 한 칸에 들어간다.
   * 로그인마다 따로 주면 같은 계정으로 들어와도 서로의 파일을 보지 못한다.
   * 🔴 세션 열쇠 자체를 쓰지 않는다 — 그 값은 쿠키에 담기는 비밀이고, 작업 공간 열쇠는
   *    DB에 적힌다. 비밀을 저장소에 베껴 두지 않으려고 따로 뽑는다.
   */
  visitor: string;
}

/** 아무 것도 안 해도 이만큼 지나면 끊는다 */
const IDLE_MS = 8 * 60 * 60 * 1000; // 8시간 — 하루 일과
/** 아무리 써도 이만큼 지나면 다시 로그인 */
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7일

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 새 세션. 돌려주는 열쇠가 쿠키에 담긴다 */
  create(userId: string): string {
    this.sweep();
    // 32바이트(256비트) — 찍어서 맞출 수 없다
    const key = randomBytes(32).toString('base64url');
    const at = this.now();
    this.sessions.set(key, { userId, createdAt: at, seenAt: at, visitor: randomBytes(12).toString('hex') });
    return key;
  }

  /**
   * 열쇠로 찾는다. 살아 있으면 `seenAt`을 갱신한다(쓰는 동안은 안 끊긴다).
   * 🔴 비교는 Map이 한다 — 열쇠가 256비트 난수라 시간 분석으로 맞출 수 없다.
   *    (토큰처럼 사람이 정한 짧은 값이면 timingSafeEqual이 필요하지만 여기는 아니다)
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

  /** 그 사람의 세션을 전부 끊는다 — 잠그거나 비밀번호를 바꿨을 때 */
  dropUser(userId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(key);
    }
  }

  /** 만료된 것을 치운다 — 세션을 만들 때마다 한 번. 따로 타이머를 두지 않는다 */
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
 * 로그인 시도 제한 — 같은 로그인 이름으로 연달아 틀리면 잠시 막는다.
 *
 * 🔴 **IP가 아니라 로그인 이름으로** 센다. 공장 안은 NAT 하나로 묶여 IP가 같은 경우가 많아
 *    IP로 세면 한 사람이 틀릴 때 전원이 막힌다.
 * 🔴 막혀도 "그 계정은 있다"를 알려 주지 않는다 — 응답은 똑같이 「로그인하지 못했습니다」다.
 */
export class LoginThrottle {
  /** 「이 계정 × 이 주소」 — 한 사람이 비밀번호를 대입하는 것을 늦춘다 */
  private readonly fails = new Map<string, { count: number; until: number }>();
  /** 「이 계정」 전체 — 주소를 바꿔 가며 대입해도 결국 멈춘다 */
  private readonly perLogin = new Map<string, { count: number; until: number }>();

  /**
   * 🔴 예전에는 **계정 이름만** 셌다(2026-10-06 보안 점검). 그러면 아무나 남의 아이디로
   *    다섯 번 틀려 그 사람을 5분씩 잠글 수 있다 — 공개 체험 서버에서는 체험 계정(admin)을
   *    누구나 잠가 모든 방문자를 막을 수 있었다. 그래서 「계정 × 주소」로 세고, 계정 전체에는
   *    훨씬 높은 상한(주소를 바꿔 가며 대입하는 것)만 둔다.
   */
  constructor(
    private readonly now: () => number = () => Date.now(),
    /** 한 주소에서 이만큼 틀리면 */
    private readonly limit = 5,
    /** 이만큼 막는다 */
    private readonly blockMs = 5 * 60 * 1000,
    /** 주소를 가리지 않고 한 계정에 이만큼 틀리면(대입 공격) */
    private readonly loginLimit = 50,
    private readonly loginBlockMs = 15 * 60 * 1000,
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
    const all = LoginThrottle.active(this.perLogin, name, at);
    return (mine?.count ?? 0) >= this.limit || (all?.count ?? 0) >= this.loginLimit;
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

  pass(login: string, address = ''): void {
    this.fails.delete(`${login.toLowerCase()}|${address}`);
  }
}

/**
 * 가입 속도 제한 — 공개 체험 서버에 봇이 붙는 것을 늦춘다(2026-10-04).
 *
 * 🔴 로그인 제한(LoginThrottle)과 막는 것이 다르다. 저쪽은 **한 계정의 비밀번호**를
 *    찍어 보는 것을 막고, 이쪽은 **계정이 수천 개 생기는 것**을 막는다. 키로 쓸 계정이
 *    아직 없으니 접속 주소로 센다.
 *
 * 🔴 전체 상한을 함께 둔다. `X-Forwarded-For`는 속일 수 있어 주소별 상한만으로는
 *    봇을 못 막는다. 전체 상한은 속일 수 없지만, 한도에 닿으면 **멀쩡한 사람도 막힌다** —
 *    공개 서버에서는 계정이 무한히 생기는 쪽이 더 나쁘다고 보고 고른 값이다.
 *    한도에 닿으면 기동 로그에 남으니 운영자가 `AAS_SIGNUP=off`로 끌 수 있다.
 */
export class SignupThrottle {
  /** 가입이 일어난 시각들(전체) */
  private readonly all: number[] = [];
  /** 주소별 가입 시각들 */
  private readonly byAddress = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** 한 시간에 서버 전체에서 받을 수 있는 가입 수 */
    private readonly globalLimit = 30,
    /** 한 시간에 한 주소에서 받을 수 있는 가입 수 */
    private readonly addressLimit = 5,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  private fresh(times: number[]): number[] {
    const from = this.now() - this.windowMs;
    while (times.length > 0 && times[0]! < from) times.shift();
    return times;
  }

  /** 막혔으면 사람이 읽을 사유, 아니면 undefined */
  blocked(address: string | undefined): string | undefined {
    if (this.fresh(this.all).length >= this.globalLimit) {
      return '지금은 가입을 받을 수 없습니다 — 잠시 뒤에 다시 시도하십시오.';
    }
    const mine = this.byAddress.get(address ?? '');
    if (mine && this.fresh(mine).length >= this.addressLimit) {
      return '같은 곳에서 가입을 너무 많이 시도했습니다 — 한 시간 뒤에 다시 시도하십시오.';
    }
    return undefined;
  }

  /** 가입이 **성공했을 때** 센다 — 실패는 계정을 만들지 않으니 셀 이유가 없다 */
  took(address: string | undefined): void {
    const at = this.now();
    this.all.push(at);
    const key = address ?? '';
    const mine = this.byAddress.get(key) ?? [];
    mine.push(at);
    this.byAddress.set(key, mine);
  }
}
