/**
 * Collection panel — status of exporting current values through the standard API — the AID name and the element idShort must match to be visible from outside.
 * Split out of components/Collection.tsx (2026-10-13 componentization) — markup, comments and checks were moved verbatim.
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
