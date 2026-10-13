/**
 * 수집 연결 만들기 — 담은 태그 — 한 줄에 이름 · 주소 · 타입. 모델에 없는 이름은 테두리로 짚는다.
 * components/AddAid.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { fill, tr } from '../../i18n.js';
import type { TagRow } from './types.js';

interface Props {
  rows: TagRow[];
  setRows: (rows: TagRow[]) => void;
  leafNames: readonly string[];
}

export function PickedTags({ rows, setRows, leafNames }: Props): React.JSX.Element {
  return (
    <ul className="picked-list">
      {rows.map((row, index) => (
        <li key={index}>
          <input
            value={row.name}
            list="leaf-names"
            aria-label={fill(tr('태그 {0} 이름'), { 0: index + 1 })}
            className={row.name.trim() !== '' && !leafNames.includes(row.name.trim()) ? 'miss' : ''}
            onChange={(event) =>
              setRows(rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)))
            }
            placeholder={tr('이름')}
          />
          <input
            value={row.href}
            className="mono"
            aria-label={fill(tr('태그 {0} 주소'), { 0: index + 1 })}
            onChange={(event) =>
              setRows(rows.map((r, i) => (i === index ? { ...r, href: event.target.value } : r)))
            }
            placeholder="NodeId"
          />
          <select
            value={row.type}
            aria-label={fill(tr('태그 {0} 타입'), { 0: index + 1 })}
            onChange={(event) =>
              setRows(rows.map((r, i) => (i === index ? { ...r, type: event.target.value } : r)))
            }
          >
            {['float', 'integer', 'string', 'boolean'].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
          <button
            className="link"
            title={tr('이 줄을 뺍니다')}
            aria-label={fill(tr('태그 {0} 지우기'), { 0: index + 1 })}
            onClick={() => setRows(rows.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
