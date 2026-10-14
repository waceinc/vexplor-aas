/**
 * Create a collection connection — pick tags browsed from the equipment (choosing while looking at current values).
 * Extracted from components/AddAid.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
 */
import type { api } from '../../api.js';
import { tr } from '../../i18n.js';
import { T } from '../T.js';

interface Props {
  found: Awaited<ReturnType<typeof api.browseDevice>>;
  picked: Set<string>;
  setPicked: (next: Set<string>) => void;
  setFound: (next: undefined) => void;
  applyPicked: () => void;
}

export function BrowsedTags({ found, picked, setPicked, setFound, applyPicked }: Props): React.JSX.Element {
  return (
    <div className="browsed">
      <div className="browsed-head">
        <b><T k={'태그 {0}개'} v={[found.nodes.length]} /></b>
        {found.truncated && <span className="warn"> {tr('· 너무 많아 일부만')}</span>}
        <span className="spacer" />
        <button
          className="link"
          title={tr('훑어 온 태그를 모두 고릅니다')}
          onClick={() => setPicked(new Set(found.nodes.map((node) => node.nodeId)))}
        >
          {tr('전체 선택')}
        </button>
        <button className="link" onClick={() => setFound(undefined)}>
          {tr('닫기 ✕')}
        </button>
      </div>
      <ul className="browsed-list">
        {found.nodes.map((node) => (
          <li key={node.nodeId}>
            <label>
              <input
                type="checkbox"
                checked={picked.has(node.nodeId)}
                onChange={(event) => {
                  const next = new Set(picked);
                  if (event.target.checked) next.add(node.nodeId);
                  else next.delete(node.nodeId);
                  setPicked(next);
                }}
              />
              <span className="tag-name">{node.name}</span>
              <span className="chip">{node.type}</span>
              {/* Important: current value — confirm "is this the right tag" right where it is picked */}
              {node.value !== undefined && <span className="now">{node.value}</span>}
              {node.error && <span className="warn">{node.error}</span>}
              <div className="mono address">{node.path}</div>
            </label>
          </li>
        ))}
      </ul>
      <button
        className="primary"
        disabled={picked.size === 0}
        title={tr('고른 태그를 아래 목록으로 가져옵니다 — 이름·단위는 거기서 고칠 수 있습니다')}
        onClick={applyPicked}
      ><T k={'고른 {0}개 담기'} v={[picked.size]} /></button>
    </div>
  );
}
