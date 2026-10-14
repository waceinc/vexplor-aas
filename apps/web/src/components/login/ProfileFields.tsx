/**
 * Login screen — member info (company name · email) — collected only on servers that published a privacy policy.
 * Split out of components/Login.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 */
interface Props {
  company: string;
  setCompany: (value: string) => void;
  email: string;
  setEmail: (value: string) => void;
  /** Required marker (*) */
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
        {/* Important: state that the address is not verified — it must not look like a verified address */}
        <span className="hint">{t('확인 메일은 보내지 않습니다.')}</span>
      </label>
    </>
  );
}
