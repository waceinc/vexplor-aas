/**
 * Create collection connection — details — also create slots for items missing from the model (category · subcategory).
 * Split out of components/AddAid.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
import { tr } from '../../i18n.js';
import { T } from '../T.js';

interface Props {
  makeElements: boolean;
  setMakeElements: (value: boolean) => void;
  group: string;
  setGroup: (value: string) => void;
  subgroup: string;
  setSubgroup: (value: string) => void;
}

export function AidOptions({ makeElements, setMakeElements, group, setGroup, subgroup, setSubgroup }: Props): React.JSX.Element {
  return (
    <details className="more">
      <summary>{tr('자세히 — 모델에 없는 항목의 자리')}</summary>
      <label className="check-line">
        <input
          type="checkbox"
          checked={makeElements}
          onChange={(event) => setMakeElements(event.target.checked)}
        />
        {tr('모델에 없는 항목의')} <b>{tr('자리도 함께 만들기')}</b>
      </label>
      {makeElements && (
        <>
          <div className="group-line">
            <input value={group} aria-label={tr('대분류')} onChange={(event) => setGroup(event.target.value)} />
            <input
              value={subgroup}
              aria-label={tr('소분류')}
              onChange={(event) => setSubgroup(event.target.value)}
            />
          </div>
          <p className="hint">
            {tr('OperationalData 아래 이 두 칸으로 묶어 만듭니다. 이미 있는 이름은 건드리지 않고, 값 칸에는 예시값이 들어갑니다(규격이 빈 칸을 위반으로 봅니다).')}
          </p>
          {/* Important: the fact that there is no undo must be said **before creating** */}
          <p className="hint warn"><T k={'⚠ 이렇게 만든 항목은 나중에 <b>「연결삭제」로 지워지지 않습니다.</b> 필요 없어지면 트리에서 직접 지워야 합니다.'} /></p>
        </>
      )}
    </details>
  );
}
