/**
 * 수집 칸 — 표준 API 로 현재값 내보내기 상태 — AID 이름과 요소 idShort 가 맞아야 밖에서 보인다.
 * components/Collection.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석·판정은 옮기기 전 글자 그대로다.
 */
import type { LiveMapping } from '../../api.js';
import { T } from '../T.js';

export function LiveMap({ live }: { live: LiveMapping }): React.JSX.Element {
  return (
    <div className={`live-map${live.applied === 0 ? ' none' : ''}`}>
      <T k={'<b>표준 API로 내보내기</b> — 수집 {0}개 중 <b>{1}개</b>가 모델 요소와 이름이 맞습니다.'} v={[live.collected, live.applied]} />
      {live.applied > 0 && (
        <>
          {' '}<T k={'{0}로 읽으면 그 자리에 현장 값이 보입니다.'} v={[<span className="mono">?live=true</span>]} /></>
      )}
      {live.notes.filter((note) => note.outcome !== 'applied').length > 0 && (
        <div className="unmatched"><T k={'이름이 맞지 않아 못 얹은 것: {0}'} v={[live.notes
            .filter((note) => note.outcome !== 'applied')
            .map((note) => note.propertyName)
            .join(' · ')]} />
        </div>
      )}
    </div>
  );
}
