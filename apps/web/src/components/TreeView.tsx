/**
 * 계층 트리 — 가상 스크롤.
 *
 * 설비 수십 종 × 수백 Property가 들어오면 DOM에 전부 그릴 수 없다(기획서 Ⅷ).
 * 라이브러리를 들이지 않고 고정 행 높이로 창을 잘라 그린다 — 규칙이 단순해 직접 두는 편이 낫다.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { FindingTally, TreeNode } from '../model.js';
import { displayValue } from '../model.js';
import { RowContent } from './tree/RowContent.js';
import { RowMenu, type OpenMenu } from './tree/RowMenu.js';

/** 행 메뉴(우클릭·「⋯」)의 항목 — 무엇을 할 수 있는지는 App이 정한다 */
export interface TreeMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 라벨이 답하지 못하는 것 — 되돌릴 수 있는지, 어디에 저장되는지 (2026-10-02) */
  title?: string;
}

/** 트리 key(JSON Pointer)의 마지막 마디 = 형제 중 몇 번째 */
const indexOf = (key: string): number => Number(/\/(\d+)$/.exec(key)?.[1] ?? NaN);
const parentOf = (key: string): string => key.replace(/\/\d+$/, '');

const ROW_HEIGHT = 26;

const OVERSCAN = 8;

interface Props {
  rows: TreeNode[];
  expanded: ReadonlySet<string>;
  tally: ReadonlyMap<string, FindingTally>;
  selected?: string;
  onToggle: (key: string) => void;
  onSelect: (node: TreeNode) => void;
  /** 이 키가 바뀌면 그 행이 보이도록 스크롤한다 (지적 → 노드 이동) */
  revealKey?: string;
  /** 찾기 결과에 걸린 노드 — 표시만 다르게 한다 */
  matched?: ReadonlySet<string>;
  /** 찾는 중에는 펼침/접힘이 의미가 없다(결과가 이미 걸러져 있다) */
  searching?: boolean;
  /**
   * 형제 안에서 `to`번째 자리로 — 끌어서 놓기·Alt+↑↓. 요소(idShortPath 있는 것)만, 같은 부모 안에서만.
   * 부모를 옮기는 것은 경로가 바뀌는 다른 연산이라 여기서 받지 않는다.
   */
  onReorder?: (node: TreeNode, to: number) => void;
  /** 우클릭·「⋯」 메뉴. 빈 배열이면 메뉴가 없다 */
  menuFor?: (node: TreeNode) => TreeMenuItem[];
  /** 번역기 — 사전에 없으면 한국어 그대로 (i18n.ts) */
  t: (text: string) => string;
}

type Menu = OpenMenu;

export function TreeView({
  rows,
  expanded,
  tally,
  selected,
  onToggle,
  onSelect,
  revealKey,
  matched,
  searching,
  onReorder,
  menuFor,
  t,
}: Props): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [dragKey, setDragKey] = useState<string>();
  /** 끌고 있는 것을 어느 행의 위/아래에 놓을지 */
  const [drop, setDrop] = useState<{ key: string; where: 'before' | 'after' }>();
  const [menu, setMenu] = useState<Menu>();

  // 메뉴는 바깥을 누르거나 Esc면 닫힌다
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const canDrag = (row: TreeNode): boolean =>
    !!onReorder && !searching && row.idShortPath !== undefined && row.linkedPackageId === undefined;
  const openMenu = (row: TreeNode, x: number, y: number): void => {
    const items = menuFor?.(row) ?? [];
    if (items.length === 0) return;
    onSelect(row);
    setMenu({ node: row, x, y, items });
  };
  /** 놓은 자리를 서버가 받는 "뺀 뒤의 인덱스"로 바꾼다 */
  const dropIndex = (from: number, target: number, where: 'before' | 'after'): number => {
    const at = where === 'before' ? target : target + 1;
    return from < at ? at - 1 : at;
  };

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!revealKey) return;
    const index = rows.findIndex((row) => row.key === revealKey);
    if (index < 0) return;
    const element = viewport.current;
    if (!element) return;
    const top = index * ROW_HEIGHT;
    // 이미 보이면 건드리지 않는다 — 클릭할 때마다 화면이 튀면 편집이 어렵다
    if (top < element.scrollTop || top > element.scrollTop + element.clientHeight - ROW_HEIGHT * 2) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 3);
    }
  }, [revealKey, rows]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const visible = rows.slice(start, start + count);

  return (
    <div
      className="tree"
      ref={viewport}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      data-testid="tree"
      role="tree"
      aria-label={t('AAS 계층')}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
          {visible.map((row) => {
            const counts = tally.get(row.pointer);
            // 접혀 있으면 자손까지 합쳐 보여 준다 — 펼치지 않고도 어디에 문제가 있는지 알아야 한다
            const shown = counts
              ? expanded.has(row.key) || row.children.length === 0
                ? counts.own
                : counts.total
              : 0;
            const value = displayValue(row.node);
            const dragging = dragKey !== undefined && dragKey !== row.key && parentOf(dragKey) === parentOf(row.key);
            return (
              <div
                key={row.key}
                className={`row${selected === row.key ? ' selected' : ''}${
                  matched?.has(row.key) ? ' hit' : ''
                }${drop?.key === row.key ? ` drop-${drop.where}` : ''}${dragKey === row.key ? ' dragging' : ''}`}
                // 들여쓰기는 CSS(.tree .row — 칸 여백 + 단계 × --tree-indent)가 맡는다. 여기서는 단계만 넘긴다
                style={{ height: ROW_HEIGHT, '--depth': row.depth } as CSSProperties}
                draggable={canDrag(row)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', row.label);
                  setDragKey(row.key);
                }}
                onDragEnd={() => {
                  setDragKey(undefined);
                  setDrop(undefined);
                }}
                onDragOver={(event) => {
                  // 같은 부모의 형제 위에서만 놓을 수 있다 — 다른 데선 커서가 「안 됨」
                  if (!dragging) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const box = event.currentTarget.getBoundingClientRect();
                  const where = event.clientY - box.top < box.height / 2 ? 'before' : 'after';
                  if (drop?.key !== row.key || drop.where !== where) setDrop({ key: row.key, where });
                }}
                onDragLeave={() => {
                  if (drop?.key === row.key) setDrop(undefined);
                }}
                onDrop={(event) => {
                  if (!dragging || !drop) return;
                  event.preventDefault();
                  const source = rows.find((r) => r.key === dragKey);
                  setDragKey(undefined);
                  setDrop(undefined);
                  if (!source) return;
                  const to = dropIndex(indexOf(source.key), indexOf(row.key), drop.where);
                  if (to !== indexOf(source.key)) onReorder?.(source, to);
                }}
                onContextMenu={(event) => {
                  if (!menuFor) return;
                  event.preventDefault();
                  openMenu(row, event.clientX, event.clientY);
                }}
                // 종류로 글자 크기·굵기를 나눈다 — 들여쓰기만으로는 계층이 안 읽힌다
                data-model-type={row.modelType}
                {...(row.linkedGroup ? { 'data-linked-group': '' } : {})}
                {...(row.linkedPart ? { 'data-linked-part': '' } : {})}
                {...(row.linkedPartGroup ? { 'data-linked-part-group': '' } : {})}
                onClick={() => onSelect(row)}
                data-pointer={row.pointer}
                // 접근성 트리에 잡혀야 스크린리더도, 브라우저 자동화도 이 행을 집을 수 있다.
                // (MCP로 실제 조작해 보고서야 빠진 것을 알았다)
                role="treeitem"
                tabIndex={0}
                aria-level={row.depth + 1}
                aria-selected={selected === row.key}
                {...(row.children.length > 0 ? { 'aria-expanded': expanded.has(row.key) } : {})}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(row);
                  }
                  if (event.key === 'ArrowRight' && row.children.length > 0 && !expanded.has(row.key)) {
                    onToggle(row.key);
                  }
                  if (event.key === 'ArrowLeft' && expanded.has(row.key)) onToggle(row.key);
                  // Alt+↑↓ = 형제 안에서 한 칸 — 마우스 없이도 순서를 바꾼다
                  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && canDrag(row)) {
                    event.preventDefault();
                    const index = indexOf(row.key);
                    const to = index + (event.key === 'ArrowUp' ? -1 : 1);
                    if (to >= 0) onReorder?.(row, to);
                  }
                }}
              >
                <RowContent
                  row={row}
                  expanded={expanded}
                  searching={searching}
                  counts={counts}
                  shown={shown}
                  value={value}
                  hasMenu={menuFor !== undefined && menuFor(row).length > 0}
                  onToggle={onToggle}
                  openMenu={openMenu}
                  t={t}
                />
              </div>
            );
          })}
        </div>
      </div>
      {menu && <RowMenu menu={menu} onClose={() => setMenu(undefined)} />}
    </div>
  );
}
