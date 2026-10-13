/**
 * 트리 계산 — 화면에 그릴 줄 · 찾기 · 지적 합산과 배지 · 고른 요소와 길 · 설비 목록 · 위반·경고·고칠 건수.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { useMemo } from 'react';
import { type EquipmentRow } from '../components/Collection.js';
import { attachFindings, buildLinkedAsset, buildTree, type LinkedInfo, flatten, searchTree, tallyFindings, type TreeNode } from '../model.js';
import { tr } from '../i18n.js';
import type { Base } from './context.js';

export function useTreeModel(c: Pick<Base, 'concepts' | 'expanded' | 'findings' | 'fixCount' | 'hierarchy' | 'linked' | 'linkedFindings' | 'query' | 'selectedKey' | 'shells' | 'submodels'>) {
  const { concepts, expanded, findings, fixCount, hierarchy, linked, linkedFindings, query, selectedKey, shells, submodels } = c;
  /**
   * 이 파일이 설비 한 대인가, 공정·회사(묶음)인가 — 표준 필드 AssetInformation.assetType(…/type/*)으로 판정.
   * 🔴 화면은 이 둘을 다른 도구처럼 대한다(사용자 2026-09-08): 설비 파일은 「서브모델·부품」을 넣고,
   *    공정 파일은 「설비·층」을 넣는다. 판정은 여기 한 곳에서만 한다
   */
  const fileUnit: 'equipment' | 'composite' = String(
    shells[0]?.assetInformation?.['assetType'] ?? '',
  ).includes('/type/')
    ? 'composite'
    : 'equipment';

  const roots = useMemo(() => {
    // 5번 HierarchicalStructures 서브모델 — 같은 이름이 설비 파일에도 회사 파일에도 있어 "왜 위에도 있나"가 됐다.
    // 주어가 다르다(설비: 부품 / 회사: 공정·설비). 종류 옆에 그 말을 단다
    const composite = String(shells[0]?.assetInformation?.['assetType'] ?? '').includes('/type/');
    // 설비 파일에는 달지 않는다 — 「부품 구성 (BOM)」 문구는 빼 달라고 했다(사용자 2026-09-09). 회사 파일에서만 헷갈리는 자리다
    const explain = (nodes: TreeNode[]): TreeNode[] =>
      composite
        ? nodes.map((node) =>
            node.modelType === 'Submodel' && node.label === 'HierarchicalStructures'
              ? {
                  ...node,
                  typeNote: tr('회사·공정 구성도'),
                  typeTitle:
                    tr('이 회사(공정)가 어느 공정·설비로 이루어졌는지 적는 표준 서브모델(IDTA 02011)입니다. 위의 ▦·⚙ 줄은 이 내용을 읽기 좋게 그린 것이고, 파일 안에 실제로 들어 있는 것은 이쪽입니다.'),
                }
              : node,
          )
        : nodes;
    /**
     * 수집 연결(AID) 서브모델에 우리말 한 줄 — 「이 서브모델은 뭐야? 장비 AASX에는 없던 건데」(사용자 2026-09-30).
     * 제출하는 참조모델에는 원래 없고, 「수집 연결 만들기」·「가상 PLC로 연결」이 붙인다. 붙은 파일은 시연본이다.
     * 공정 화면은 설비 파일의 서브모델까지 이어 그리므로 트리 전체를 훑는다
     */
    const noteAid = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((node) =>
        node.modelType === 'Submodel' && node.label === 'AssetInterfacesDescription'
          ? {
              ...node,
              typeNote: tr('수집 연결'),
              typeTitle:
                tr('설비의 OPC UA 주소와 읽을 태그를 적는 표준 서브모델(IDTA 02017 Asset Interfaces Description)입니다. ') +
                tr('「수집 연결 만들기」나 「가상 PLC로 연결」을 누르면 이 파일에 더해집니다. 원본 참조모델에는 원래 없으며, ') +
                tr('이것이 붙은 파일은 시연본입니다 — 필요 없으면 오른쪽 수집 칸의 「연결 삭제」로 지웁니다.'),
            }
          : node.children.length > 0
            ? { ...node, children: noteAid(node.children) }
            : node,
      );
    const base = noteAid(explain(buildTree({ shells, submodels, conceptDescriptions: concepts })));
    if (!hierarchy?.entryNode || hierarchy.children.length === 0) return base;
    // 🔴 설비 파일(부품 BoM)에서는 최상단 ⚙/· 줄을 그리지 않는다(2026-09-09 사용자 검토 "HierarchicalStructures
    //    영역에 포함되게 하면 되지 않나"). 부품은 이미 5번 HierarchicalStructures 서브모델 안에 표준 Entity 트리로
    //    있고, 편집은 가운데 「부품 구성 (BoM)」이 맡는다 — 최상단 줄은 같은 것을 한 번 더 보여 줄 뿐이었고
    //    파일이 없으니 눌러도 갈 데가 없었다. 2026-09-08에 되돌렸던 것을 사용자 검토로 다시 걷는다.
    //    공정 파일은 다르다 — 그 줄이 파일을 건너 설비의 서브모델까지 이어 붙이는 자리다(「공정 → 장비 → 서브모델」)
    if (fileUnit === 'equipment') return base;
    // 설비 가지는 AAS 노드 바로 다음에 둔다 — 「공정 → 장비 → 서브모델」 순서로 읽힌다
    const assets = noteAid(linked.map((info) => buildLinkedAsset(info, '/linked', { part: false })));
    const cut = shells.length; // shell 노드들 바로 뒤
    return [...base.slice(0, cut), ...assets, ...base.slice(cut)];
    // 🔴 hierarchy·linked가 빠지면 자식 서브모델을 읽어 와도 트리가 다시 안 그려진다(실측)
  }, [shells, submodels, concepts, hierarchy, linked]);
  /**
   * 찾기 — 한 파일에 요소가 200개를 넘어 눈으로 훑는 것은 무리다.
   * 찾는 동안에는 **걸러진 트리**를 그린다(찾은 노드 + 거기까지 가는 길).
   */
  const searching = query.trim() !== '';
  const search = useMemo(() => searchTree(roots, query), [roots, query]);
  /**
   * 수집 연결에서 이름을 맞출 대상 — 값을 가질 수 있는 잎 요소의 idShort.
   * AID 서브모델 자신의 요소(base·href…)는 뺀다 — 그 이름에 맞추면 안 된다.
   */
  const leafNames = useMemo(() => {
    const names = new Set<string>();
    const valued = new Set(['Property', 'MultiLanguageProperty', 'Range', 'File', 'Blob']);
    const walk = (nodes: readonly TreeNode[], inAid: boolean): void => {
      for (const node of nodes) {
        const aidHere = inAid || node.label === 'AssetInterfacesDescription';
        if (!aidHere && valued.has(node.modelType) && node.node.idShort) {
          names.add(String(node.node.idShort));
        }
        walk(node.children, aidHere);
      }
    };
    walk(roots, false);
    return [...names].sort();
  }, [roots]);
  const rows = useMemo(
    () => (searching ? search.rows : flatten(roots, expanded)),
    [searching, search, roots, expanded],
  );
  /**
   * 화면에 이어 붙인 설비 파일들 — 공정(묶음)을 열면 ⚙ 가지마다 하나씩.
   * 지적 합산과 「자동 고치기」가 같은 목록을 본다 — 둘이 갈라지면 "지적은 보이는데 못 고친다"가 된다.
   */
  const mounts = useMemo(() => {
    const found: { pid: string; key: string; name: string }[] = [];
    const walk = (nodes: LinkedInfo[], prefix: string): void => {
      for (const node of nodes) {
        const key = `${prefix}/${node.name}`;
        if (node.packageId && !found.some((m) => m.pid === node.packageId))
          found.push({ pid: node.packageId, key, name: node.name });
        walk(node.children, key);
      }
    };
    walk(linked, '/linked');
    return found;
  }, [linked]);
  /**
   * 지금 파일 + 연결 파일들의 지적을 한 목록으로.
   * pointer에 트리의 mount 자리(/linked/…)를 붙여 클릭하면 그 요소로 점프한다.
   *
   * 🔴 연결 파일 지적의 `fixable`을 끄지 않는다(2026-10-01 사용자 지적으로 바로잡음).
   *    예전에는 꺼 두어 공정 파일에서 「자동 고치기」가 늘 비활성이었다. 그런데 같은 화면의
   *    값 편집·서브모델 추가는 **그 설비 파일로 저장된다**(targetOf) — 고치기만 막은 것은
   *    앞뒤가 맞지 않았다. 이제 고치기도 파일별로 나눠 각자의 원본에 쓴다.
   */
  const allFindings = useMemo(() => {
    if (Object.keys(linkedFindings).length === 0) return findings;
    const merged = [...findings];
    for (const mount of mounts) {
      for (const finding of linkedFindings[mount.pid] ?? []) {
        merged.push({
          ...finding,
          pointer: `${mount.key}${finding.pointer}`,
          key: `${mount.name} · ${finding.key ?? ''}`,
        });
      }
    }
    return merged;
  }, [findings, linkedFindings, mounts]);
  // 🔴 트리 배지(색·숫자)도 합산본을 본다 — 묶음에서 ⚙ 가지의 위반 위치가
  //    "건수는 오른쪽에 있는데 왼쪽엔 없는" 반쪽이었다(2026-08-26 사용자 제보)
  const findingsByNode = useMemo(() => attachFindings(roots, allFindings), [roots, allFindings]);
  const tally = useMemo(() => tallyFindings(roots, findingsByNode), [roots, findingsByNode]);
  /** 접혀 있어도 찾을 수 있게 위치로 색인해 둔다 */
  const byPointer = useMemo(() => {
    const map = new Map<string, TreeNode>();
    const walk = (nodes: readonly TreeNode[]): void => {
      for (const node of nodes) {
        map.set(node.pointer, node);
        walk(node.children);
      }
    };
    walk(roots);
    return map;
  }, [roots]);
  const selected = selectedKey === undefined ? undefined : byPointer.get(selectedKey);
  /** 고른 요소까지의 길 — 인스펙터 제목에 "어디의 요소인지"를 보여 준다 */
  const selectedTrail = useMemo(() => {
    if (!selected) return [];
    const trail: string[] = [];
    const walk = (nodes: readonly TreeNode[], acc: string[]): boolean => {
      for (const node of nodes) {
        const next = [...acc, node.label];
        if (node.key === selected.key) {
          trail.push(...next.slice(0, -1)); // 자기 이름은 제목이 이미 크게 쓴다
          return true;
        }
        if (walk(node.children, next)) return true;
      }
      return false;
    };
    walk(roots, []);
    return trail;
  }, [roots, selected]);
  /**
   * 공정 파일의 오른쪽 칸 — 매달린 설비와 수집 연결 상태(2026-10-01 사용자 피드백).
   * 그룹·하위 묶음은 내려가고, 설비 파일 밑(부품 BoM)은 내려가지 않는다
   */
  const equipmentRows = useMemo((): EquipmentRow[] => {
    const rows: EquipmentRow[] = [];
    const walk = (nodes: LinkedInfo[], path: string[]): void => {
      for (const node of nodes) {
        if (node.group || node.composite) {
          walk(node.children, [...path, node.name]);
          continue;
        }
        rows.push({
          name: node.name,
          group: path.join(' › '),
          bulkCount: node.bulkCount,
          ...(node.packageId ? { packageId: node.packageId } : {}),
          connected: (node.submodels ?? []).some((submodel) => submodel.idShort === 'AssetInterfacesDescription'),
        });
      }
    };
    walk(linked, []);
    return rows;
  }, [linked]);
  const equipmentName = (pid: string): string => equipmentRows.find((row) => row.packageId === pid)?.name ?? pid;
  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const warnings = allFindings.filter((f) => f.severity === 'warning').length;
  // 「자동 고치기」가 실제로 손대는 것만 센다 — 고칠 수 있는 위반과 **경고**(2026-09-07부터. 파일마다
  //    AASd-120 경고 1건이 늘 남아 사람이 "왜 안 지워지나" 물었다. 경고를 고쳐도 KOSMO엔 영향이 없다).
  // 🔴 연결 설비 파일의 지적도 센다(2026-10-01) — 공정 파일에서도 고칠 수 있게 됐다.
  //    단추 숫자는 미리보기가 실제로 고치겠다고 한 수인데, 그 선계산은 **지금 파일 것만** 받는다.
  //    그래서 연결 지적이 있으면 규칙의 fixable 표시로 센다 — 팝업을 열면 정확한 수가 나온다.
  const linkedFixable = allFindings.filter(
    (f) => f.fixable && f.severity !== 'info' && f.pointer.startsWith('/linked/'),
  ).length;
  const fixable =
    linkedFixable > 0
      ? (fixCount ?? 0) + linkedFixable
      : (fixCount ?? allFindings.filter((f) => f.fixable && f.severity !== 'info').length);

  return { fileUnit, roots, searching, search, leafNames, rows, mounts, allFindings, findingsByNode, tally, byPointer, selected, selectedTrail, equipmentRows, equipmentName, errors, warnings, linkedFixable, fixable };
}
