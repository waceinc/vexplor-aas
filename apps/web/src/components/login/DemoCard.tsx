/**
 * Login screen — trial guidance — demo account card (one button to sign in).
 * Split out of components/Login.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
interface Props {
  demo: { login: string; password: string };
  disabled: boolean;
  onEnter: () => void;
  t: (text: string) => string;
}

export function DemoCard({ demo, disabled, onEnter, t }: Props): React.JSX.Element {
  return (
    <>
      <div className="login-divider" role="separator">
        <span>{t('가입 없이 먼저 써 보기')}</span>
      </div>

      {/*
        Trial guidance — placed as one card **below** the login (user and design review, 2026-10-06).
        Important: when it sat above, returning members also had to pass the trial guidance first, and with two blue buttons
           the main action was blurred. Login is this server's proper entrance — the trial button is an outlined (secondary) button.
        Important: at first it was two lines of small grey text. It is **the first thing** someone arriving at the trial server
           needs to know (how to get in · what works and what does not), yet it went unnoticed (user, 2026-10-04).
        Important: the ID and password are not just written down — **one button signs you in**.
           There is no reason to make people read and retype them. The values are still shown (we do not hide what you sign in with).
      */}
      <section className="demo-card" aria-label={t('체험판 안내')}>
        <h2>{t('데모 계정')}</h2>
        <dl>
          <dt>{t('아이디')}</dt>
          <dd><code>{demo.login}</code></dd>
          <dt>{t('비밀번호')}</dt>
          <dd><code>{demo.password}</code></dd>
        </dl>
        <button
          className="big demo-enter"
          type="button"
          disabled={disabled}
          onClick={onEnter}
        >
          {t('데모 계정으로 들어가기')}
        </button>
        <ul>
          <li>{t('열기 · 고치기 · 검사 · 자동 고치기 — 전부 됩니다')}</li>
          <li>{t('체험판은 일정 시간 후 초기화됩니다')}</li>
          <li className="locked">{t('파일 내려받기는 회원가입 후에 됩니다')}</li>
        </ul>
      </section>
    </>
  );
}
