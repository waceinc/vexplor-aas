/**
 * Left pane — search and the AAS tree. Row menus (⋯ · right-click) and selection behavior are defined here.
 * Split out of App.tsx (componentization, 2026-10-13) — markup, class names and comments are verbatim from before the move,
 * and the state and actions it uses arrive as props with the same names.
 */
import { CONTAINER_TYPES } from '../components/AddElement.js';
import { fill, tr } from '../i18n.js';
import { TreeView } from '../components/TreeView.js';

import type { Screen } from './context.js';

export function TreePane(props: Pick<Screen, 'adding' | 'busy' | 'expanded' | 'fileUnit' | 'loadPackage' | 'onDelete' | 'onDuplicate' | 'onMove' | 'onRemoveHierarchyNode' | 'query' | 'reveal' | 'rows' | 'search' | 'searching' | 'selected' | 'setAdding' | 'setExpanded' | 'setHierAdder' | 'setQuery' | 'setReveal' | 'setSelectedKey' | 'setSubmodelTarget' | 't' | 'tally'>): React.JSX.Element {
  const { adding, busy, expanded, fileUnit, loadPackage, onDelete, onDuplicate, onMove, onRemoveHierarchyNode, query, reveal, rows, search, searching, selected, setAdding, setExpanded, setHierAdder, setQuery, setReveal, setSelectedKey, setSubmodelTarget, t, tally } = props;

  return (
    <div className="tree-pane">
      <div className="search">
        <input
          value={query}
          aria-label={tr('트리에서 찾기')}
          placeholder={tr('찾기 — 이름·값·semanticId')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
        />
        {searching && (
          <>
            <span className={`count${search.matched.size === 0 ? ' none' : ''}`}>
              {search.matched.size === 0 ? tr('없음') : fill(tr('{0}건'), { 0: search.matched.size })}
            </span>
            <button className="link" title={tr('찾는 말을 지웁니다')} onClick={() => setQuery('')}>
              {tr('지우기')}
            </button>
          </>
        )}
      </div>
    <TreeView
      t={t}
      rows={rows}
      expanded={expanded}
      matched={search.matched}
      searching={searching}
      tally={tally}
      {...(selected ? { selected: selected.key } : {})}
      {...(reveal ? { revealKey: reveal } : {})}
      onToggle={(key) => {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setExpanded(next);
      }}
      // Reorder, duplicate and delete directly on tree rows — drag and drop, right-click / "⋯" menu, Alt+↑↓.
      // (feedback that the "↑ Up" / "↓ Down" buttons under the middle pane were unclear, 2026-09-04)
      onReorder={(node, to) => void onMove(node, { to })}
      menuFor={(node) => {
        if (busy) return [];
        // ── Composition rows (▦ process · ⚙ equipment · name-only equipment) — registration shortcuts. In a company file most rows are these,
        //    and without a menu they looked like "a lot missing in the middle" (user, 2026-09-09). Parts (·) and the "BOM (n)" drawer have no actions
        if (node.modelType === 'LinkedAsset' && node.key.startsWith('/linked/')) {
          if (node.linkedPart || node.linkedPartGroup) return [];
          const path = node.key.replace(/^\/linked\//, '').split('/');
          const name = path[path.length - 1]!;
          const parent = path.slice(0, -1);
          const remove = {
            label: tr('이 구성에서 빼기'),
            danger: true,
            onClick: () => void onRemoveHierarchyNode(name, parent),
          };
          if (node.linkedGroup) {
            return [
              ...(node.linkedLine ? [{ label: t('＋ 공정'), onClick: () => setHierAdder({ path, kind: 'group' }) }] : []),
              { label: fileUnit === 'equipment' ? t('＋ 부품') : t('＋ 설비'), onClick: () => setHierAdder({ path, kind: 'asset' }) },
              remove,
            ];
          }
          if (node.linkedPackageId !== undefined) {
            const pid = node.linkedPackageId;
            return [
              {
                label: t('이 설비에 서브모델 추가'),
                onClick: () => {
                  setSubmodelTarget({ pid, assetName: node.node.idShort ?? node.label });
                  setAdding('submodel');
                  setSelectedKey(undefined);
                },
              },
              { label: tr('이 설비 파일 열기'), onClick: () => void loadPackage(pid) },
              remove,
            ];
          }
          return [remove]; // name only · file not open
        }
        // ── Top AAS row — same as "Add to this file"
        if (node.modelType === 'AssetAdministrationShell') {
          return fileUnit === 'composite'
            ? [
                { label: t('＋ 공정'), onClick: () => setHierAdder({ path: [], kind: 'group' }) },
                { label: t('＋ 설비'), onClick: () => setHierAdder({ path: [], kind: 'asset' }) },
                { label: tr('서브모델 추가'), onClick: () => setAdding('submodel') },
              ]
            : [
                { label: tr('서브모델 추가'), onClick: () => setAdding('submodel') },
                { label: t('＋ 부품'), onClick: () => setHierAdder({ path: [], kind: 'asset' }) },
              ];
        }
        const editable = node.modelType === 'Submodel' || node.idShortPath !== undefined;
        if (!editable) return [];
        const element = node.idShortPath !== undefined;
        // ── Elements linked in from another file — saves go to that file (same scope as the property pane: add/delete elements).
        //    Reorder and duplicate by opening that file
        if (node.linkedPackageId !== undefined) {
          return [
            ...(CONTAINER_TYPES.has(node.modelType) ? [{ label: t('요소 추가'), title: tr('이 안에 새 요소를 만듭니다'), onClick: () => setAdding(node) }] : []),
            ...(element ? [{ label: t('삭제'), danger: true, title: tr('잘못 지웠으면 헤더의 ↶ 되돌리기'), onClick: () => void onDelete(node) }] : []),
          ];
        }
        const index = Number(/\/(\d+)$/.exec(node.key)?.[1] ?? NaN);
        return [
          ...(CONTAINER_TYPES.has(node.modelType)
            ? [{ label: t('요소 추가'), title: tr('이 안에 새 요소를 만듭니다'), onClick: () => setAdding(node) }]
            : []),
          // Important: duplicate only container elements — it is for when you need **the whole structure** once more, like a second certification mark, document or contact.
          //    Duplicating a single Property just produced X_2 with the same value, prompting "why is this here?" (user, 2026-09-09)
          ...(element && CONTAINER_TYPES.has(node.modelType)
            ? [{ label: t('사본 만들기 (복제)'), title: tr('안의 요소와 값까지 그대로 하나 더 (이름 끝에 _2)'), onClick: () => void onDuplicate(node) }]
            : []),
          ...(element
            ? [
                { label: t('↑ 한 칸 위로'), onClick: () => void onMove(node, { offset: -1 }), disabled: index <= 0 },
                { label: t('↓ 한 칸 아래로'), onClick: () => void onMove(node, { offset: 1 }) },
              ]
            : []),
          { label: t('삭제'), danger: true, title: tr('잘못 지웠으면 헤더의 ↶ 되돌리기'), onClick: () => void onDelete(node) },
        ];
      }}
      onSelect={(node) => {
        // Important: if an input form (new file, add submodel, etc.) is open in the middle pane, get it out of the way first.
        //    Previously the editor was attached **below** the form, off-screen — to the user it looked like "the click
        //    does nothing" (observed 2026-09-07). Selecting in the tree means wanting to look at that
        if (adding) setAdding(undefined);
        // Important: branches (equipment) read from another file are not edited here —
        //    the source of truth is that one equipment file. Only expand it and leave a hint
        // Important: beginner principle (2026-08-26): the screen matching what you selected appears in place.
        //    Selecting the top level (AAS) shows the composition screen (add process/equipment); selecting a ▦ group makes that group
        //    the insertion target; selecting ⚙ equipment shows that equipment's actions (add submodel, etc.)
        if (node.modelType === 'AssetAdministrationShell') {
          setSelectedKey(undefined);
          setHierAdder(undefined);
          setExpanded(new Set([...expanded, node.key]));
          return; // No-selection screen = summary + what it is made of (add at top level)
        }
        if (node.modelType === 'LinkedAsset') {
          const next = new Set(expanded);
          if (node.linkedPart || node.linkedPartGroup) {
            // Parts (BoM) and the collapsed "Parts (n)" — no file, no actions. Only expand and collapse
            if (next.has(node.key)) next.delete(node.key);
            else next.add(node.key);
            setExpanded(next);
            setSelectedKey(undefined);
            return;
          }
          next.add(node.key); // Selecting also expands — saves a second click
          setExpanded(next);
          if (node.linkedPackageId === undefined) {
            // ▦ Process (level without a file) — open a "＋ Equipment" input row under that row in the middle composition tree
            const path = node.key.replace(/^\/linked\//, '').split('/');
            setHierAdder({ path, kind: 'asset' });
            setSelectedKey(undefined);
            return;
          }
          // ⚙ Equipment — equipment context screen (rendered in middle below)
          setSelectedKey(node.key);
          setReveal(undefined);
          return;
        }
        setSelectedKey(node.key);
        setReveal(undefined);
      }}
    />
    </div>
  );
}
