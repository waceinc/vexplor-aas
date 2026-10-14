/**
 * 로그인 화면 — 회원 정보(회사명 · 이메일) — 처리방침을 올린 서버에서만 받는다.
 * components/Login.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
interface Props {
  company: string;
  setCompany: (value: string) => void;
  email: string;
  setEmail: (value: string) => void;
  /** 필수 표시(*) */
  req: React.ReactNode;
  t: (text: string) => string;
}

export function ProfileFields({ company, setCompany, email, setEmail, req, t }: Props): React.JSX.Element {
  return (
    <>
      <label>
        {t('회사명')} <span className="dim">{t('(선택)')}</span>
        <input
          value={company}
          autoComplete="organization"
          maxLength={80}
          onChange={(event) => setCompany(event.target.value)}
        />
      </label>
      <label>
        {t('이메일')}
        {req}
        <input
          aria-required
          type="email"
          value={email}
          autoComplete="email"
          maxLength={120}
          onChange={(event) => setEmail(event.target.value)}
        />
        {/* 🔴 확인하지 않는다는 사실을 적는다 — 확인된 주소인 양 두면 안 된다 */}
        <span className="hint">{t('확인 메일은 보내지 않습니다.')}</span>
      </label>
    </>
  );
}
