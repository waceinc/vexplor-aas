/**
 * Tree computation — rows to draw · search · finding totals and badges · selected element and its path · equipment list · violation/warning/fixable counts.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move;
 * the state and actions it uses arrive under the same names (taken from c).
 */
import { useMemo } from 'react';
import { type EquipmentRow } from '../components/Collection.js';
import { attachFindings, buildLinkedAsset, buildTree, type LinkedInfo, flatten, searchTree, tallyFindings, type TreeNode } from '../model.js';
import { tr } from '../i18n.js';
import type { Base } from './context.js';

export function useTreeModel(c: Pick<Base, 'concepts' | 'expanded' | 'findings' | 'fixCount' | 'hierarchy' | 'linked' | 'linkedFindings' | 'query' | 'selectedKey' | 'shells' | 'submodels'>) {
  const { concepts, expanded, findings, fixCount, hierarchy, linked, linkedFindings, query, selectedKey, shells, submodels } = c;
  /**
   * Is this file a single piece of equipment, or a process/company (bundle)? Decided by the standard field AssetInformation.assetType (…/type/*).
   * Important: the screen treats the two like different tools (user 2026-09-08): equipment files take "submodels · components",
   *    process files take "equipment · levels". The decision is made here and nowhere else
   */
  const fileUnit: 'equipment' | 'composite' = String(
    shells[0]?.assetInformation?.['assetType'] ?? '',
  ).includes('/type/')
    ? 'composite'
    : 'equipment';

  const roots = useMemo(() => {
    // Submodel no. 5, HierarchicalStructures — the same name appears in equipment files and company files, prompting "why is it up there too?".
    // The subject differs (equipment: components / company: processes · equipment). Attach that wording next to the kind
    const composite = String(shells[0]?.assetInformation?.['assetType'] ?? '').includes('/type/');
    // Not attached in equipment files — the user asked to drop the "Component structure (BOM)" wording (user 2026-09-09). Only company files are confusing here
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
     * One plain-language line for the collection connection (AID) submodel — "what is this submodel? the equipment AASX didn't have it" (user 2026-09-30).
     * The submitted reference model does not have it; "Create collection connection" / "Connect to virtual PLC" add it. A file carrying it is a demo copy.
     * The process view draws the equipment files' submodels too, so scan the whole tree
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
    // Important: equipment files (component BoM) do not draw the top-level ⚙/· rows (user review 2026-09-09: "couldn't it just go inside the
    //    HierarchicalStructures area?"). Components already exist as a standard Entity tree inside submodel no. 5, HierarchicalStructures,
    //    and editing is handled by the middle "Component structure (BoM)" — the top-level rows only showed the same thing again,
    //    and with no file behind them, clicking led nowhere. What was reverted on 2026-09-08 is removed again after user review.
    //    Process files differ — there those rows splice across files into the equipment's submodels ("process → equipment → submodel")
    if (fileUnit === 'equipment') return base;
    // Place equipment branches right after the AAS node — so it reads in "process → equipment → submodel" order
    const assets = noteAid(linked.map((info) => buildLinkedAsset(info, '/linked', { part: false })));
    const cut = shells.length; // right after the shell nodes
    return [...base.slice(0, cut), ...assets, ...base.slice(cut)];
    // Important: without hierarchy · linked, the tree is not redrawn even after child submodels are read (measured)
  }, [shells, submodels, concepts, hierarchy, linked]);
  /**
   * Search — a file has over 200 elements, too many to scan by eye.
   * While searching, draw a **filtered tree** (matched nodes + the path to them).
   */
  const searching = query.trim() !== '';
  const search = useMemo(() => searchTree(roots, query), [roots, query]);
  /**
   * Targets to match names against in a collection connection — the idShort of leaf elements that can hold values.
   * Exclude the AID submodel's own elements (base · href…) — names must not be matched to those.
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
   * Equipment files spliced into the screen — one per ⚙ branch when a process (bundle) is opened.
   * Finding totals and "Auto-fix" look at the same list — if they diverge, it becomes "findings are visible but cannot be fixed".
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
   * Findings of the current file + linked files as one list.
   * The tree mount point (/linked/…) is prefixed to the pointer so clicking jumps to that element.
   *
   * Important: do not turn off `fixable` on linked-file findings (corrected after a user report on 2026-10-01).
   *    It used to be off, so "Auto-fix" was always disabled in process files. Yet on the same screen
   *    value edits and submodel additions **are saved to that equipment file** (targetOf) — blocking only fixes
   *    was inconsistent. Now fixes are also split per file and written to each source.
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
  // Important: tree badges (color · number) also use the merged list — in a bundle, violations in ⚙ branches were
  //    half-shown: "the count is on the right but not on the left" (user report 2026-08-26)
  const findingsByNode = useMemo(() => attachFindings(roots, allFindings), [roots, allFindings]);
  const tally = useMemo(() => tallyFindings(roots, findingsByNode), [roots, findingsByNode]);
  /** Indexed by position so it can be found even when collapsed */
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
  /** Path to the selected element — shows "where the element belongs" in the inspector title */
  const selectedTrail = useMemo(() => {
    if (!selected) return [];
    const trail: string[] = [];
    const walk = (nodes: readonly TreeNode[], acc: string[]): boolean => {
      for (const node of nodes) {
        const next = [...acc, node.label];
        if (node.key === selected.key) {
          trail.push(...next.slice(0, -1)); // the title already shows its own name prominently
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
   * Right pane of a process file — attached equipment and collection connection status (user feedback 2026-10-01).
   * Descends into groups and sub-bundles, but not below equipment files (component BoM)
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
  // Count only what "Auto-fix" actually touches — fixable violations and **warnings** (since 2026-09-07. Every file
  //    always kept one AASd-120 warning and people asked "why won't it go away?". Fixing warnings has no effect on KOSMO).
  // Important: findings in linked equipment files are counted too (2026-10-01) — they became fixable from process files.
  //    The button count is what the preview said it would actually fix, but that precomputation covers **only the current file**.
  //    So when there are linked findings, count by the rules' fixable flag — opening the popup gives the exact number.
  const linkedFixable = allFindings.filter(
    (f) => f.fixable && f.severity !== 'info' && f.pointer.startsWith('/linked/'),
  ).length;
  const fixable =
    linkedFixable > 0
      ? (fixCount ?? 0) + linkedFixable
      : (fixCount ?? allFindings.filter((f) => f.fixable && f.severity !== 'info').length);

  return { fileUnit, roots, searching, search, leafNames, rows, mounts, allFindings, findingsByNode, tally, byPointer, selected, selectedTrail, equipmentRows, equipmentName, errors, warnings, linkedFixable, fixable };
}
