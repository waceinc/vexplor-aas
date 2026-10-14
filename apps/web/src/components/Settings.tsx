/**
 * 설정 — 지금은 언어 하나뿐이다.
 *
 * 🔴 **영어가 어디까지인지 먼저 말한다.** 화면 글자와 서버가 만드는 글(지적 문구·규칙 설명·
 *    검증 결과서·번들 안내·오류)은 모두 영어가 있다(2026-10-14). 영어 화면에도 한국어로 남는 것은
 *    **파일에서 온 것**(이름·값)과 **제출 묶음의 폴더·파일 이름**(제출 구조가 정한 이름)뿐이다.
 *    모르고 보면 "번역이 덜 됐다"로 읽힌다 — 그래서 무엇이 남는지 적어 둔다.
 *
 * 🔴 **언어를 바꾸면 화면을 새로 읽는다**(부르는 쪽이 한다). 파일 맨 위에 적어 둔 글자표는
 *    처음 읽힌 언어로 굳어 있어, 다시 그리기만 하면 반쪽만 바뀐다(i18n.ts `current`).
 */
import type { Lang } from '../i18n.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  lang: Lang;
  onChange: (lang: Lang) => void;
  onClose: () => void;
  t: (text: string) => string;
}

export function Settings({ lang, onChange, onClose, t }: Props): React.JSX.Element {
  return (
    <div className="settings">
      <h2>{t('설정')}</h2>

      <section>
        <h3>{t('언어')}</h3>
        <div className="row-buttons">
          <button
            className={lang === 'ko' ? 'primary' : ''}
            title={tr('화면 글자를 한국어로 — 모든 글자가 한국어입니다')}
            onClick={() => onChange('ko')}
          >
            {/* i18n-ignore — 언어 이름은 그 언어로 적는다(영어 화면에서도 「한국어」) */}
            한국어
          </button>
          <button
            className={lang === 'en' ? 'primary' : ''}
            title={tr('화면 글자와 서버가 만드는 글(지적 문구·검증 결과서)을 영어로')}
            onClick={() => onChange('en')}
          >
            English
          </button>
        </div>
        <p className="note">
          <T k={'영어를 고르면 화면 글자와 지적 문구·규칙 설명·검증 결과서가 모두 영어로 나옵니다. <b>파일에서 온 이름과 값</b>, 제출 묶음의 폴더 이름은 그대로 남습니다.'} />
        </p>
        <p className="hint">
          {tr('고른 언어는 이 브라우저에 남습니다. 서버 설정이 아니라 보는 사람마다 따로입니다.')}{' '}
          {tr('언어를 바꾸면 화면을 새로 읽습니다 — 파일은 그대로 있고, 저장하지 않은 입력만 사라집니다.')}
        </p>
      </section>

      <div className="row-buttons actions">
        <button className="primary" onClick={onClose}>
          {t('닫기')}
        </button>
      </div>
    </div>
  );
}
