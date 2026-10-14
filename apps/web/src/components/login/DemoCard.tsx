/**
 * 로그인 화면 — 체험판 안내 — 데모 계정 카드(단추 하나로 들어간다).
 * components/Login.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
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
        체험판 안내 — 로그인 **아래**에 카드 한 장으로 둔다(2026-10-06 사용자·디자인 검토).
        🔴 위에 두었더니 다시 찾아온 회원도 체험 안내부터 지나야 했고, 파란 단추가 둘이라
           주인공이 흐렸다. 로그인이 이 서버의 정식 입구다 — 체험 단추는 테두리 단추(보조)로 둔다.
        🔴 처음에는 회색 잔글씨 두 줄이었다. 체험 서버에 온 사람이 **가장 먼저 알아야 하는 것**
           (어떻게 들어가나 · 무엇이 되고 안 되나)인데 눈에 들어오지 않았다(사용자 2026-10-04).
        🔴 아이디·비밀번호를 적어 두기만 하지 않고 **단추 하나로 들어가게** 한다 —
           보고 베껴 치게 할 이유가 없다. 값은 그대로 보여 준다(무엇으로 들어가는지 숨기지 않는다).
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
          <li>{t('체험판은 일정 시간 후 초기화 됩니다')}</li>
          <li className="locked">{t('파일 내려받기는 회원가입 후에 됩니다')}</li>
        </ul>
      </section>
    </>
  );
}
