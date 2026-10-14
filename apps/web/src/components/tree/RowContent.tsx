/**
 * Tree list — row contents — expand marker · name · kind · one-line plain description · value · finding badge · "⋯" menu button.
 * Split out of components/TreeView.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 */
import type { FindingTally, TreeNode } from '../../model.js';
import { fill, tr } from '../../i18n.js';

interface Props {
  row: TreeNode;
  expanded: ReadonlySet<string>;
  searching: boolean | undefined;
  counts: FindingTally | undefined;
  /** Badge number — when collapsed, includes descendants */
  shown: number;
  value: string;
  hasMenu: boolean;
  onToggle: (key: string) => void;
  openMenu: (row: TreeNode, x: number, y: number) => void;
  t: (text: string) => string;
}

export function RowContent({ row, expanded, searching, counts, shown, value, hasMenu, onToggle, openMenu, t }: Props): React.JSX.Element {
  return (
    <>
      <span
        className={`twist${row.children.length > 0 && !searching ? '' : ' leaf'}`}
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation();
          if (row.children.length > 0 && !searching) onToggle(row.key);
        }}
      >
        {/* While searching, collapsing/expanding is meaningless — the results are already filtered */}
        {row.children.length > 0 && !searching ? (expanded.has(row.key) ? '▾' : '▸') : '·'}
      </span>
      <span className="label">{row.label}</span>
      {/* When name and kind are the same, like AssetInformation, do not write it twice */}
      {/* Kind is the spec's original (English) text — we tried translating it but the user chose English (2026-09-07).
          It must match KOSMO findings and Package Explorer to be comparable. Only the glossary collection (virtual level) leaves kind empty */}
      {/* Parts show kind as Part — if it were LinkedAsset like equipment, beginners would read it as a machine (2026-09-08) */}
      {row.modelType !== row.label && row.modelType !== 'ConceptDescriptionGroup' && !row.linkedPartGroup && (
        <span className="type">{row.linkedPart ? 'Part' : row.modelType}</span>
      )}
      {/* One-line plain description — keep the spec name and add "what this is" beside it (HierarchicalStructures) */}
      {row.typeNote && (
        <span className="type note" {...(row.typeTitle ? { title: row.typeTitle } : {})}>
          · {row.typeNote}
        </span>
      )}
      {/* Truncated values are shown in full on hover */}
      {value && (
        <span className="value" title={value}>
          {value}
        </span>
      )}
      {shown > 0 && counts && (
        <span
          className={`badge ${counts.worst}`}
          title={
            expanded.has(row.key) || row.children.length === 0
              ? fill(tr('이 요소의 지적 {0}건'), { 0: counts.own })
              : fill(tr('아래에 지적 {0}건 (펼쳐서 확인)'), { 0: counts.total })
          }
        >
          {shown}
        </span>
      )}
      {/* "⋯" — so people who do not know right-click can still find the menu. Shown on hover or selection */}
      {hasMenu && (
        <button
          type="button"
          className="more"
          aria-label={fill(tr('{0} 메뉴'), { 0: row.label })}
          title={t('이 항목으로 할 수 있는 일 (우클릭도 됩니다)')}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            openMenu(row, box.left, box.bottom + 2);
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          ⋯
        </button>
      )}
    </>
  );
}
