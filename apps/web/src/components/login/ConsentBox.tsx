/**
 * Sign-in screen — consent to collecting and using personal data — what · why · how long, right above the consent box.
 * Extracted from components/Login.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
 */
interface Props {
  agreed: boolean;
  setAgreed: (value: boolean) => void;
  privacyUrl: string | undefined;
  req: React.ReactNode;
  t: (text: string) => string;
}

export function ConsentBox({ agreed, setAgreed, privacyUrl, req, t }: Props): React.JSX.Element {
  return (
    <div className="consent">
      <p className="consent-title">
        {t('개인정보 수집·이용 동의 (필수)')}
        {req}
      </p>
      <dl>
        <dt>{t('항목')}</dt>
        <dd>{t('아이디 · 이름 · 이메일 · 비밀번호(암호화 저장) · 회사명(선택)')}</dd>
        <dt>{t('목적')}</dt>
        <dd>{t('회원 식별 · 서비스 제공 · 문의 응대')}</dd>
        <dt>{t('보유 기간')}</dt>
        <dd>{t('탈퇴할 때까지 — 탈퇴하면 올린 파일과 함께 지웁니다')}</dd>
      </dl>
      <p className="hint">{t('동의하지 않을 수 있으나, 그 경우 가입할 수 없습니다. 가입 없이 데모 계정으로 써 볼 수 있습니다.')}</p>
      <label className="agree">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>
          {t('위 내용과 ')}
          <a href={privacyUrl} target="_blank" rel="noreferrer">
            {t('개인정보처리방침')}
          </a>
          {t('에 동의합니다.')}
        </span>
      </label>
    </div>
  );
}
