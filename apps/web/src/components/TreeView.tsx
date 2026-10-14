/**
 * Hierarchy tree — virtual scrolling.
 *
 * With dozens of equipment types × hundreds of Properties the DOM cannot draw everything (spec Ⅷ).
 * Instead of adding a library, it slices a window with a fixed row height — the rule is simple enough to keep in-house.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { FindingTally, TreeNode } from '../model.js';
import { displayValue } from '../model.js';
import { RowContent } from './tree/RowContent.js';
import { RowMenu, type OpenMenu } from './tree/RowMenu.js';

/** An item of the row menu (right-click · "⋯") — App decides what can be done */
export interface TreeMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** What the label cannot answer — whether it can be undone, where it is saved (2026-10-02) */
  title?: string;
}

/** Last segment of the tree key (JSON Pointer) = position among siblings */
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
  /** When this key changes, scroll so that row is visible (finding → jump to node) */
  revealKey?: string;
  /** Nodes matched by the search — only their display differs */
  matched?: ReadonlySet<string>;
  /** Expand/collapse is meaningless while searching (results are already filtered) */
  searching?: boolean;
  /**
   * Move to position `to` among siblings — drag and drop · Alt+↑↓. Elements only (those with an idShortPath), within the same parent only.
   * Moving to another parent changes the path, which is a different operation, so it is not accepted here.
   */
  onReorder?: (node: TreeNode, to: number) => void;
  /** Right-click · "⋯" menu. An empty array means no menu */
  menuFor?: (node: TreeNode) => TreeMenuItem[];
  /** Translator — falls back to the Korean text when the dictionary has no entry (i18n.ts) */
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
  /** Which row, and above or below it, the dragged item will be dropped at */
  const [drop, setDrop] = useState<{ key: string; where: 'before' | 'after' }>();
  const [menu, setMenu] = useState<Menu>();

  // The menu closes on an outside click or Esc
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
  /** Convert the drop position into the "index after removal" the server expects */
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
    // Leave it alone if already visible — if the view jumps on every click, editing gets hard
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
            // When collapsed, show descendants' counts too — users must see where problems are without expanding
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
                // Indentation is handled by CSS (.tree .row — cell padding + level × --tree-indent). Only the level is passed here
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
                  // Drop is allowed only over siblings of the same parent — elsewhere the cursor shows "not allowed"
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
                // Font size · weight vary by kind — indentation alone does not make the hierarchy readable
                data-model-type={row.modelType}
                {...(row.linkedGroup ? { 'data-linked-group': '' } : {})}
                {...(row.linkedPart ? { 'data-linked-part': '' } : {})}
                {...(row.linkedPartGroup ? { 'data-linked-part-group': '' } : {})}
                onClick={() => onSelect(row)}
                data-pointer={row.pointer}
                // It must be in the accessibility tree so screen readers and browser automation can pick this row.
                // (We only noticed it was missing after actually driving it through MCP)
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
                  // Alt+↑↓ = one step among siblings — reorder without a mouse
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
