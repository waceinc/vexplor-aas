/**
 * 왼쪽 칸 — 찾기와 AAS 나무 목록. 줄 메뉴(⋯ · 우클릭)와 고르기 동작을 여기서 정한다.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업 · 클래스 이름 · 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름의 props 로 받는다.
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
      // 순서·복제·삭제는 트리 행에서 바로 — 끌어서 놓기, 우클릭·「⋯」 메뉴, Alt+↑↓.
      // (가운데 칸 아래의 「↑ 위로」「↓ 아래로」 버튼은 무엇인지 알 수 없다는 지적, 2026-09-04)
      onReorder={(node, to) => void onMove(node, { to })}
      menuFor={(node) => {
        if (busy) return [];
        // ── 구성 줄(▦ 공정 · ⚙ 설비 · 이름만 설비) — 등록 편의 동작. 회사 파일에서는 줄의 대부분이 이것인데
        //    메뉴가 없어 "중간에 많이 누락"으로 보였다(사용자 2026-09-09). 부품(·)과 「BOM (n)」 서랍은 동작이 없다
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
          return [remove]; // 이름만 · 파일 안 열림
        }
        // ── 맨 위 AAS 줄 — 「이 파일에 넣기」와 같은 것
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
        // ── 다른 파일에서 이어 붙인 요소 — 저장은 그 파일로 간다(속성 칸과 같은 범위: 요소 추가·삭제).
        //    순서·사본은 그 파일을 열어서
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
          // 🔴 사본은 담는 요소에만 — 두 번째 인증 마크·문서·연락처처럼 **구조째** 하나 더 필요할 때 쓰는 것이다.
          //    낱개 Property를 복제해 봐야 같은 값의 X_2가 생길 뿐이라 "이게 왜 있나"가 됐다(사용자 2026-09-09)
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
        // 🔴 가운데에 입력 폼(새로 만들기·서브모델 추가 등)이 열려 있으면 먼저 비켜 준다.
        //    전에는 폼 **아래에** 편집기가 붙어 화면 밖에 있었다 — 사람 눈에는 "클릭이
        //    안 먹는다"로 보였다(2026-09-07 실측). 트리를 골랐다는 것은 그쪽을 보겠다는 뜻이다
        if (adding) setAdding(undefined);
        // 🔴 다른 파일에서 읽어 온 가지(설비)는 여기서 고칠 대상이 아니다 —
        //    원본은 그 설비 파일 한 군데다. 펼치기만 하고, 안내를 남긴다
        // 🔴 초보자 원칙(2026-08-26): 고른 것에 맞는 화면이 그 자리에 나온다.
        //    최상위(AAS)를 고르면 구성(공정·설비 추가) 화면, ▦그룹을 고르면 그 그룹이
        //    넣을 자리가 되고, ⚙설비를 고르면 그 설비의 동작(서브모델 추가 등)이 나온다
        if (node.modelType === 'AssetAdministrationShell') {
          setSelectedKey(undefined);
          setHierAdder(undefined);
          setExpanded(new Set([...expanded, node.key]));
          return; // 무선택 화면 = 요약 + 무엇으로 이루어졌나(최상위에 넣기)
        }
        if (node.modelType === 'LinkedAsset') {
          const next = new Set(expanded);
          if (node.linkedPart || node.linkedPartGroup) {
            // 부품(BoM)·「부품 (n)」 접힘 — 파일도 동작도 없다. 펼치고 접기만 한다
            if (next.has(node.key)) next.delete(node.key);
            else next.add(node.key);
            setExpanded(next);
            setSelectedKey(undefined);
            return;
          }
          next.add(node.key); // 고르면 펼쳐도 준다 — 두 번 누를 일을 줄인다
          setExpanded(next);
          if (node.linkedPackageId === undefined) {
            // ▦ 공정(파일 없는 층) — 가운데 구성 트리의 그 줄 밑에 「＋ 설비」 입력 줄을 연다
            const path = node.key.replace(/^\/linked\//, '').split('/');
            setHierAdder({ path, kind: 'asset' });
            setSelectedKey(undefined);
            return;
          }
          // ⚙ 설비 — 설비 컨텍스트 화면(아래 middle에서 그린다)
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
