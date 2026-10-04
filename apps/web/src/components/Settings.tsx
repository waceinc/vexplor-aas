/**
 * 설정 — 지금은 언어 하나뿐이다.
 *
 * 🔴 **영어가 어디까지인지 먼저 말한다.** 화면 글자는 영어가 있지만, 서버가 만드는 글
 *    (지적 문구·규칙 설명·검증 결과서)은 한국어로 나온다. 모르고 고르면 "번역이 깨졌다"로
 *    읽히고, 알고 고르면 "거기까지는 아직이구나"가 된다. 같은 화면이라도 둘은 전혀 다르다.
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
            title={tr('화면 글자를 영어로 — 서버가 만드는 글(지적 문구·검증 결과서)은 한국어로 남습니다')}
            onClick={() => onChange('en')}
          >
            English
          </button>
        </div>
        <p className="note warn">
          <T k={'영어는 <b>화면 글자</b>까지 옮겼습니다. 지적 문구·규칙 설명·검증 결과서는 서버가 만드는 글이라 아직 한국어로 나옵니다 — 섞여 보이는 것이 정상입니다.'} />
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
