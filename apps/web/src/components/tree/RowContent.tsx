/**
 * 나무 목록 — 줄 안쪽 — 펼침 표시 · 이름 · 종류 · 우리말 한 줄 · 값 · 지적 배지 · 「⋯」 메뉴 단추.
 * components/TreeView.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import type { FindingTally, TreeNode } from '../../model.js';
import { fill, tr } from '../../i18n.js';

interface Props {
  row: TreeNode;
  expanded: ReadonlySet<string>;
  searching: boolean | undefined;
  counts: FindingTally | undefined;
  /** 배지 숫자 — 접혀 있으면 자손까지 합친 값 */
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
        {/* 찾는 중에는 접고 펴는 게 의미가 없다 — 결과가 이미 걸러져 있다 */}
        {row.children.length > 0 && !searching ? (expanded.has(row.key) ? '▾' : '▸') : '·'}
      </span>
      <span className="label">{row.label}</span>
      {/* AssetInformation처럼 이름과 종류가 같으면 두 번 쓰지 않는다 */}
      {/* 종류는 규격 원문(영문) 그대로 — 우리말로 바꿔 봤으나 사용자가 영문을 택했다(2026-09-07).
          KOSMO 지적문·Package Explorer와 같은 글자여야 대조가 된다. 뜻풀이 모음(가상 층)만 종류를 비운다 */}
      {/* 부품은 종류를 Part로 — 설비와 같은 LinkedAsset이면 초보자가 장비로 읽는다(2026-09-08) */}
      {row.modelType !== row.label && row.modelType !== 'ConceptDescriptionGroup' && !row.linkedPartGroup && (
        <span className="type">{row.linkedPart ? 'Part' : row.modelType}</span>
      )}
      {/* 우리말 한 줄 — 규격명은 그대로 두고 그 옆에 "이건 무엇"을 단다(HierarchicalStructures) */}
      {row.typeNote && (
        <span className="type note" {...(row.typeTitle ? { title: row.typeTitle } : {})}>
          · {row.typeNote}
        </span>
      )}
      {/* 잘린 값은 마우스를 올리면 전부 보인다 */}
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
      {/* 「⋯」 — 우클릭을 모르는 사람도 메뉴를 찾을 수 있게. 마우스를 올리거나 고르면 보인다 */}
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
