/**
 * 저작 UI — 기획서 M3.
 *
 * 한 흐름을 세로로 관통시킨다: 파일 열기 → 트리 편집 → 지적 확인 → 고치기 → 내려받기.
 * Package Explorer를 흉내 내지 않고 **지적을 중심**에 뒀다 — 그게 이 제품의 차별점이기 때문이다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  ConflictError,
  ForbiddenError,
  currentToken,
  setToken,
  type AuthState,
  UnauthorizedError,
  type AidInterfaceView,
  type HierarchyNode,
  type HierarchyView,
  type HistoryEntry,
  type UndoStatus,
  type CycleReportView,
  type LiveMapping,
  type CollectedValueView,
  type FixReport,
  type PackageDescription,
  type Policy,
} from './api.js';
import { AddAid } from './components/AddAid.js';
import { AddElement, CONTAINER_TYPES } from './components/AddElement.js';
import { AddSubmodel } from './components/AddSubmodel.js';
import { NewPackage } from './components/NewPackage.js';
import type { Adder, DraftNode } from './components/HierarchyTree.js';
import { DocAssets } from './components/DocAssets.js';
import { BundlePanel } from './components/BundlePanel.js';
import { Rules } from './components/Rules.js';
import { FindingsPanel } from './components/FindingsPanel.js';
import { FixPreview, type FixPlan } from './components/FixPreview.js';
import { Accounts } from './components/Accounts.js';
import { Login } from './components/Login.js';
import { Menu } from './components/Menu.js';
import { Settings } from './components/Settings.js';
import { fill, readLang, translator, writeLang, type Lang } from './i18n.js';
import { ImportSubmodel } from './components/ImportSubmodel.js';
import { Collection, type EquipmentRow } from './components/Collection.js';
import { Splitter } from './components/Splitter.js';
import {
  clampPanes,
  DEFAULT_PANES,
  gridTemplate,
  loadPanes,
  resizePanes,
  savePanes,
  type Handle,
  type PaneWidths,
} from './panes.js';
import { Hierarchy } from './components/Hierarchy.js';
import { Summary } from './components/Summary.js';
import { Inspector } from './components/Inspector.js';
import { TreeView } from './components/TreeView.js';
import {
  attachFindings,
  buildLinkedAsset,
  buildTree,
  childrenOfHierarchy,
  countElements,
  type LinkedInfo,
  flatten,
  localTime,
  revealPath,
  searchTree,
  tallyFindings,
  type Finding,
  type ConceptDescription,
  type Shell,
  type Submodel,
  type TreeNode,
} from './model.js';
import { tr } from './i18n.js';
import { T } from './components/T.js';

/**
 * 서버가 준 문장을 그대로 띄우면 「TypeError: Failed to fetch」 같은 것이 사용자에게 간다.
 * 자주 오는 세 가지만 사람 말로 바꾸고, 나머지는 서버 문장을 그대로 쓴다(그쪽은 이미 한국어다).
 */
export function describeError(caught: unknown): string {
  // 🔴 403은 더 이상 「읽기 전용 토큰」 하나가 아니다 — 보기 전용 **계정**, 다른 사이트에서
  //    온 요청, 설치 코드 불일치도 403이다(2026-10-02). 서버가 왜인지 적어 보내므로
  //    그 문장을 그대로 쓴다. 앞에 토큰 이야기를 붙이면 엉뚱한 안내가 된다
  if (caught instanceof ForbiddenError)
    return caught.message.trim() || tr('권한이 없습니다 — 쓰기 권한이 있는 계정이나 토큰으로 다시 들어오십시오.');
  if (caught instanceof ApiError) {
    if (caught.status === 413) return fill(tr('파일이 상한을 넘습니다 — {0}'), { 0: caught.message });
    return caught.message;
  }
  // fetch 자체가 실패하면 TypeError다 — 서버가 꺼졌거나 주소가 틀렸거나 망이 끊긴 것
  if (caught instanceof TypeError) return tr('서버에 연결할 수 없습니다 — API 서버가 꺼져 있거나 네트워크가 끊겼습니다.');
  return caught instanceof Error ? caught.message : String(caught);
}

export function App(): React.JSX.Element {
  const [packages, setPackages] = useState<PackageDescription[]>([]);
  const [packageId, setPackageId] = useState<string>();
  const [submodels, setSubmodels] = useState<Submodel[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /**
   * 선택은 **노드 객체가 아니라 위치**로 들고 있는다.
   * 저장할 때마다 서버에서 다시 읽어 트리를 새로 만들기 때문에, 객체를 쥐고 있으면
   * 화면에 낡은 값이 남는다.
   */
  const [selectedKey, setSelectedKey] = useState<string>();
  /** 트리에서 찾기 */
  const [query, setQuery] = useState('');
  /** 서버가 인증을 켜 두었는데 토큰이 없거나 틀렸을 때의 안내 문구 */
  const [needsToken, setNeedsToken] = useState<string>();
  const [reveal, setReveal] = useState<string>();
  const [fixReport, setFixReport] = useState<FixReport>();
  const [policy, setPolicy] = useState<Policy>();
  const [shells, setShells] = useState<Shell[]>([]);
  const [concepts, setConcepts] = useState<ConceptDescription[]>([]);
  const shell = shells[0];
  const conceptIds = useMemo(() => new Set(concepts.map((cd) => cd.id)), [concepts]);
  /** Submodel id → 리비전. 편집할 때 If-Match로 되돌려 보낸다 */
  const [interfaces, setInterfaces] = useState<AidInterfaceView[]>([]);
  // 공정의 계층 — 설비 파일에도 부품 계층이 있어 같은 자리에서 읽힌다
  const [hierarchy, setHierarchy] = useState<HierarchyView | undefined>(undefined);
  /** 파일 목록 패널 — 쌓인 파일을 한눈에 보고 지운다 */
  const [filesOpen, setFilesOpen] = useState(false);
  /** 파일 목록에서 체크한 것 — 일괄 지우기 대상. 목록을 닫으면 비운다 */
  const [pickedFiles, setPickedFiles] = useState<ReadonlySet<string>>(new Set());
  /**
   * 서브모델 추가가 향할 파일 — 기본은 지금 파일. ⚙ 설비 컨텍스트의 「이 설비에 서브모델
   * 추가」가 그 설비 파일로 바꾼다(초보자 요청: 고른 장비에 바로 만들어져야 한다)
   */
  const [submodelTarget, setSubmodelTarget] = useState<
    { pid: string; assetName: string } | undefined
  >();
  /** 「무엇으로 이루어졌나」의 넣을 자리 — 트리에서 ▦그룹을 눌러도 잡힌다 */
  /** 구성 트리에 열려 있는 입력 줄 — 트리의 ▦ 클릭·요약의 「＋ …」로도 열리므로 여기서 든다 */
  const [hierAdder, setHierAdder] = useState<Adder>();
  /** 이력 패널 — 어느 서브모델의 이력을 보는 중인가 */
  const [historyFor, setHistoryFor] = useState<{ submodelId: string; label: string } | undefined>();
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  /** 트리에 이어 붙일 자식 가지(재귀) — 회사→공정→장비까지 */
  const [linked, setLinked] = useState<LinkedInfo[]>([]);
  /**
   * 공정 화면에서 고른 설비 요소의 CD 확인은 **그 설비 파일의 CD**로 한다.
   * 🔴 공정 파일 것으로 확인하니 SPR의 복합 IRDI(0173-1#02-ABI500#003/0173-1#01-AHF579#003)에
   *    「CD가 파일에 없습니다」 경고가 거짓으로 떴다 — CD는 SPR 파일에 있다(사용자 2026-09-30)
   */
  const linkedConceptIds = useMemo(() => {
    const byPackage = new Map<string, ReadonlySet<string>>();
    const walk = (nodes: LinkedInfo[]): void => {
      for (const node of nodes) {
        if (node.packageId && node.concepts) byPackage.set(node.packageId, new Set(node.concepts.map((cd) => cd.id)));
        walk(node.children);
      }
    };
    walk(linked);
    return byPackage;
  }, [linked]);
  /** 연결 파일의 서브모델 revision — ⚙ 가지를 **직접 고칠 때** 충돌 보호에 쓴다 */
  const [linkedRevisions, setLinkedRevisions] = useState<Record<string, Record<string, number>>>({});
  /**
   * 연결 파일의 지적 — 오른쪽 패널에 합쳐 보여 준다.
   * 🔴 ⚙ 밑을 고치면 저장은 그 파일로 가는데 지적이 안 보이면 "고쳤는데 검사는 안 되는"
   *    반쪽이 된다(2026-08-26 사용자 제보). packageId → 그 파일의 findings
   */
  const [linkedFindings, setLinkedFindings] = useState<Record<string, Finding[]>>({});
  const [values, setValues] = useState<CollectedValueView[]>([]);
  /** 수집값이 모델 요소와 이름이 맞는지 — 표준 API로 내보낼 수 있는지의 판정 */
  const [live, setLive] = useState<LiveMapping>();
  /** 자동 수집 상태 — 서버가 주기 수집을 켜 뒀는가 */
  const [autoCollect, setAutoCollect] = useState<Awaited<ReturnType<typeof api.collectStatus>>>();
  /** OPC UA로 내주고 있는가(M6·M7). 꺼진 배포가 기본이라 없을 수 있다 */
  const [opcua, setOpcua] = useState<Awaited<ReturnType<typeof api.opcuaStatus>>>();
  /** 서버가 알려 주는 판 번호 — 화면과 서버가 어긋나면 새로고침이 필요하다는 신호이기도 하다 */
  const [version, setVersion] = useState<string>();
  /** 마지막 수집 주기의 결과 — 연결 상태 아이콘의 근거 */
  const [lastCycle, setLastCycle] = useState<CycleReportView>();
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  /** 되돌리기 스택 — 서버가 들고 있고 화면은 라벨만 본다 */
  const [undoState, setUndoState] = useState<UndoStatus>({ undo: [], redo: [] });
  const [shellRevisions, setShellRevisions] = useState<Record<string, number>>({});
  const [conflict, setConflict] = useState<string>();
  /** 열려 있는 추가 폼 — 'submodel'이거나 부모 노드 */
  const [adding, setAdding] = useState<'submodel' | 'import' | 'new' | 'docs' | 'aid' | 'bundle' | TreeNode>();
  /** 규칙·규약 화면 — 판정 근거를 보여 준다 */
  const [showRules, setShowRules] = useState(false);
  /**
   * 지적 목록을 팝업으로 볼지.
   * 🔴 오른쪽 칸을 상시 차지하던 것을 걷어냈다 — 대부분의 시간에는 「몇 건인가」만 알면 되고,
   *    목록은 볼 때만 보면 된다. 그 자리는 수집(OPC UA)이 쓴다(2026-09-01 사용자 요청).
   */
  const [showFindings, setShowFindings] = useState(false);
  /**
   * 화면 글자의 언어 — 이 브라우저에만 남는다(서버 설정이 아니다).
   * 🔴 영어는 화면 뼈대만 있다. 없는 글자는 한국어로 나온다 — i18n.ts 머리말 참조.
   */
  /**
   * 로그인 상태 — 화면이 가장 먼저 묻는다(2026-10-02).
   * 🔴 undefined는 "아직 모른다"다. 모르는 동안 로그인 화면을 띄우면 이미 로그인한 사람에게
   *    한 번 깜빡인다 — 셋 중 하나로 갈릴 때까지 아무 것도 그리지 않는다.
   */
  const [auth, setAuth] = useState<AuthState>();
  /**
   * 「첫 관리자 만들기」를 스스로 연 것인가.
   *
   * 🔴 계정도 토큰도 없는 서버는 로그인 화면을 **띄우지 않는다**(아무도 못 들어가니까).
   *    그런데 그러면 계정을 쓰기 시작할 길도 없다 — 사내 서버로 올려 놓고 "로그인은
   *    어떻게 켜나"가 되는 자리다. 「설정」 메뉴에서 여기로 들어온다.
   */
  const [startAccounts, setStartAccounts] = useState(false);
  /** 탈퇴 확인 — 되돌릴 수 없는 일이라 한 번 묻는다 */
  const [confirmQuit, setConfirmQuit] = useState(false);
  /**
   * 체험 계정으로 보고 있나 — 내려받기가 막힌 상태다.
   * 🔴 가입해 자기 계정으로 들어오면 `auth.demo`가 비고 제한이 풀린다(서버가 정한다).
   */
  const demoLocked = auth?.demo !== undefined;
  const [lang] = useState<Lang>(() => readLang());
  const [showSettings, setShowSettings] = useState(false);
  /** 계정 화면 — 내 비밀번호, 그리고 관리자면 사람 더하기·역할·잠그기 */
  const [showAccounts, setShowAccounts] = useState(false);
  const t = useMemo(() => translator(lang), [lang]);
  /**
   * 자동 고치기 미리보기 — 열려 있으면 팝업. 체크한 것만 반영한다(사용자 2026-09-11).
   * 🔴 **파일마다 한 묶음**이다. 공정(묶음)을 열면 이어 붙인 설비 파일들도 함께 들어온다
   *    (2026-10-01). 고치기는 각자의 원본 파일로 간다 — 편집·서브모델 추가와 같은 길이다.
   */
  const [fixPlans, setFixPlans] = useState<FixPlan[] | undefined>();
  /** IRI 이관 대장(새 → 원본) — 파일 안 파트. 비어 있으면 요약에 아무것도 안 뜬다 */
  const [ledger, setLedger] = useState<Record<string, string>>({});
  /**
   * 미리보기가 "못 고친다"고 한 지적 수 — 단추 숫자와 팝업이 어긋나지 않게 하는 근거.
   * 🔴 규칙의 fixable 표시만 믿으면 단추는 「2건」인데 들어가면 "사람이 판단"이 된다(사용자 2026-09-11).
   *    파일을 열 때 저장 없는 미리보기를 한 번 돌려, 실제로 못 고치는 지적은 fixable을 끈다
   */
  const [unfixable, setUnfixable] = useState(0);
  /** 미리보기가 실제로 고치겠다고 한 건수 — 단추의 숫자. 한 지적을 고치면 다음 바퀴에 드러나는 것까지 센다(팝업 줄 수와 같다) */
  const [fixCount, setFixCount] = useState<number | undefined>();
  /**
   * 세 칸 너비 — 사용자가 끌어 정한다(2026-09-01 요청).
   * 🔴 창 크기 안에 들어오는지는 `clampPanes`가 늘 다시 본다. 창을 줄였을 때
   *    저장해 둔 너비가 그대로 남으면 오른쪽 칸이 사라져 되돌릴 손잡이조차 없어진다.
   */
  const [panes, setPanes] = useState<PaneWidths>(() => loadPanes() ?? DEFAULT_PANES);
  const mainRef = useRef<HTMLElement>(null);
  /**
   * 지금 창의 가로 폭. 🔴 `panes`는 **사람이 바란 값**이고, 그리는 값은 창에 맞춰 그때그때 줄인다
   * (`clampPanes`). 전에는 줄인 값을 상태에 덮어써서 — 창을 한 번 좁혔다 넓히면 오른쪽 칸이
   * 최소(260px)에 눌러앉아 돌아오지 않았다(2026-09-09 실측, 1024→1920).
   */
  const [room, setRoom] = useState<number>(() => globalThis.innerWidth ?? 1280);

  /** 지금 창에서 쓸 수 있는 가로 폭 — 없으면 창 너비로 갈음한다(첫 렌더) */
  const paneRoom = (): number => mainRef.current?.clientWidth ?? globalThis.innerWidth ?? 1280;
  const shownPanes = clampPanes(panes, room);

  const movePane = (handle: Handle, delta: number): void => {
    // 끌기는 지금 보이는 칸에서 시작한다 — 바라는 값이 창보다 크면 손잡이가 엉뚱한 데서 움직인다
    setPanes((current) => resizePanes(clampPanes(current, paneRoom()), handle, delta, paneRoom()));
  };
  /** 저장은 끌기가 끝났을 때 한 번만 — 움직일 때마다 쓰면 localStorage를 두드린다 */
  const commitPanes = (): void => setPanes((current) => (savePanes(current), current));

  // 창 크기가 바뀌면 다시 맞춘다 — 안 그러면 좁혀진 창에서 칸 하나가 사라진다
  useEffect(() => {
    const onResize = (): void => setRoom(paneRoom());
    globalThis.addEventListener('resize', onResize);
    onResize();
    return () => globalThis.removeEventListener('resize', onResize);
  }, []);
  /** 「내주는 중」 칩을 눌렀을 때 — 주소가 무엇을 뜻하는지 여기서만 말한다 */
  const [showOpcua, setShowOpcua] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  /** 마지막으로 연 파일. 같은 파일을 다시 읽을 때 펼침 상태를 지키는 데 쓴다 */
  const openedRef = useRef<string>(undefined);

  // 🔴 공정을 열면 자식 설비의 서브모델을 각 파일에서 읽어 온다 — 트리가
  //    「A공정 → 장비 → 장비별 서브모델」로 그려지려면 이 내용이 필요하다.
  //    파일이 안 열려 있는 자식은 이름만 남는다(트리가 그 사실을 보여 준다).
  useEffect(() => {
    let alive = true;
    if (!hierarchy?.entryNode || hierarchy.children.length === 0) {
      setLinked([]);
      setLinkedFindings({});
      return undefined;
    }
    void (async () => {
      const revisionsByPackage: Record<string, Record<string, number>> = {};
      const findingsByPackage: Record<string, Finding[]> = {};
      // 🔴 재귀 — 자식이 또 계층 파일이면(회사→공정→장비) 그 자식까지 읽는다.
      //    깊이 3 제한 + 방문 기록으로 순환을 끊는다(서버도 막지만 화면은 화면대로 지킨다)
      const load = async (
        children: HierarchyNode[],
        depth: number,
        visited: Set<string>,
      ): Promise<LinkedInfo[]> => {
        const out: LinkedInfo[] = [];
        for (const child of children) {
          const info: LinkedInfo = { name: child.name, bulkCount: child.bulkCount, children: [] };
          if (child.globalAssetId === '') {
            // 그룹(파일 없는 중간 마디) — 같은 파일 안의 자식을 그대로 내려간다.
            // 파일을 건너는 것이 아니라 depth는 늘지 않는다
            info.group = true;
            info.children = await load(child.children, depth, visited);
          } else {
            const source = packages.find(
              (item) => item.globalAssetId === child.globalAssetId && item.packageId !== packageId,
            );
            if (source && depth < 3 && !visited.has(child.globalAssetId)) {
              try {
                const [list, revs, lintReport, conceptList] = await Promise.all([
                  api.submodels(source.packageId),
                  api.revisions(source.packageId),
                  api.lint(source.packageId),
                  api.conceptDescriptions(source.packageId),
                ]);
                revisionsByPackage[source.packageId] = revs.Submodel;
                findingsByPackage[source.packageId] = lintReport.findings;
                info.packageId = source.packageId;
                if (String(source.assetType ?? '').includes('/type/')) info.composite = true;
                info.submodels = list.result;
                info.concepts = conceptList.result;
                const nested = childrenOfHierarchy(
                  list.result.find((submodel) => submodel.idShort === 'HierarchicalStructures'),
                );
                info.children = await load(
                  nested as never,
                  depth + 1,
                  new Set([...visited, child.globalAssetId]),
                );
              } catch {
                // 읽기 실패 — 이름만 남긴다. 편집 흐름을 막을 일이 아니다
              }
            }
          }
          out.push(info);
        }
        return out;
      };
      const next = await load(hierarchy.children, 0, new Set());
      if (alive) {
        setLinked(next);
        setLinkedRevisions(revisionsByPackage);
        setLinkedFindings(findingsByPackage);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hierarchy, packages, packageId]);

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
                tr('「수집 연결 만들기」나 「가상 PLC로 연결」을 누르면 이 파일에 더해집니다. 제출하는 참조모델에는 원래 없으며, ') +
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

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await work();
    } catch (caught) {
      // 충돌은 오류가 아니라 상황이다 — 덮어쓰지 않았다는 사실과 함께 다시 읽을 길을 준다
      if (caught instanceof ConflictError) setConflict(caught.message);
      // 토큰이 없거나 틀렸다 — 오류 문구 대신 입력 자리를 준다
      else if (caught instanceof UnauthorizedError) setNeedsToken(caught.message);
      else setError(describeError(caught));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const loadPackage = useCallback(
    async (id: string) => {
      await run(async () => {
        const [tree, report, rules, shellList, conceptList, revs, aid, samples, preview] = await Promise.all([
          api.submodels(id),
          api.lint(id),
          api.policy(id),
          api.shells(id),
          api.conceptDescriptions(id),
          api.revisions(id),
          api.interfaces(id),
          api.values(id),
          // 저장 없는 미리보기 — 실제로 고쳐질 것과 못 고칠 것을 가른다(단추 숫자의 근거)
          api.fixPreview(id).catch(() => undefined),
        ]);
        const cannot = new Set((preview?.skipped ?? []).map((s) => `${s.ruleId}|${s.pointer}`));
        setUnfixable(cannot.size);
        setFixCount(preview?.applied.length);
        // 수집 어댑터가 없는 배포에서도 조회는 된다(시계열이 비어 있으면 0건)
        setLive(await api.liveMapping(id).catch(() => undefined));
        // 🔴 계층 서브모델이 없는 파일은 400이 온다 — 그건 잘못이 아니라 그런 파일인 것이다
        setHierarchy(await api.hierarchy(id).catch(() => undefined));
        setAutoCollect(await api.collectStatus().catch(() => undefined));
        setOpcua(await api.opcuaStatus().catch(() => undefined));
        setLedger(await api.relocations(id).then((r) => r.relocations).catch(() => ({})));
        setUndoState(await api.undoStatus(id).catch(() => ({ undo: [], redo: [] })));
        setSubmodels(tree.result);
        setFindings(
          report.findings.map((finding) =>
            finding.fixable && cannot.has(`${finding.ruleId}|${finding.pointer}`) ? { ...finding, fixable: false } : finding,
          ),
        );
        setPolicy(rules);
        setShells(shellList.result);
        setConcepts(conceptList.result);
        setInterfaces(aid.interfaces);
        setValues(samples.result);
        setRevisions(revs.Submodel);
        setShellRevisions(revs.AssetAdministrationShell);
        setConflict(undefined);
        // 🔴 다른 파일의 수집 결과를 이어서 보여 주면 안 된다 — 인터페이스 이름이 같아
        // (둘 다 InterfaceTemplateForOPCUA) 남의 상태가 내 것처럼 보인다.
        // 함수형 갱신은 나중에 돌아 openedRef가 이미 새 값이 된다 — 지금 바로 비교한다
        if (openedRef.current !== id) {
          setLastCycle(undefined);
          setFixReport(undefined);
          setHierAdder(undefined);
          setSubmodelTarget(undefined);
          // 🔴 이전 파일의 선택이 남으면 새 파일에서 요약·구성 화면이 안 보이는데
          //    이유를 알 수 없다(디자인 점검 중 실측) — 파일이 바뀌면 선택도 비운다
          setSelectedKey(undefined);
        }
        setPackageId(id);
        // 같은 파일을 다시 읽는 것(저장·추가 뒤)이면 펼침 상태를 지킨다.
        // 편집할 때마다 트리가 접히면 깊은 요소를 손볼 수 없다
        // AAS와 서브모델은 처음부터 펼쳐 둔다. 접힌 트리는 무엇이 있는지 보이지 않는다.
        // (AAS 아래에는 AssetInformation 하나뿐이라 펼쳐도 어지럽지 않다)
        const defaults = new Set([
          ...shellList.result.map((_, index) => `/assetAdministrationShells/${index}`),
          ...tree.result.map((_, index) => `/submodels/${index}`),
        ]);
        const sameFile = openedRef.current === id;
        openedRef.current = id;
        setExpanded((current) => (sameFile && current.size > 0 ? current : defaults));
      });
    },
    [run],
  );

  /** 첫 화면 — 파일 목록을 읽고 첫 파일을 연다. 토큰을 넣은 뒤에도 이걸 다시 부른다 */
  const bootstrap = useCallback(async () => {
    // 🔴 로그인 상태가 먼저다. 로그인하지 않았으면 목록을 부를 이유가 없고,
    //    부르면 401이 떠서 "오류"처럼 보인다
    const state = await api.authMe().catch(
      (): AuthState => ({ authenticated: false, setupNeeded: false, authRequired: false }),
    );
    setAuth(state);
    if (state.authRequired && !state.authenticated && currentToken() === undefined) return;
    await run(async () => {
      const list = await api.listPackages();
      setPackages(list.result);
      if (list.result[0]) await loadPackage(list.result[0].packageId);
      // 파일이 하나도 없어도 규약은 필요하다 — 첫 화면의 「새로 만들기」가 쓴다
      else setPolicy(await api.globalPolicy());
    });
  }, [run, loadPackage]);

  useEffect(() => {
    void bootstrap();
    // 판 번호는 인증 없이도 읽힌다(/health) — 토큰 넣기 전에도 화면에 보인다
    void fetch('/health')
      .then((response) => response.json())
      .then((body: { version?: string }) => setVersion(body.version))
      .catch(() => undefined);
  }, [bootstrap]);

  const onUpload = async (file: File): Promise<void> => {
    // 같은 이름이 이미 있으면 알려 준다 — 막지는 않는다(다른 판을 나란히 볼 수도 있다).
    // 안 알리면 목록에 같은 이름이 나란히 쌓여 어느 것이 어느 것인지 모른다(3전문가 시연 실측)
    const duplicate = packages.some((item) => item.name === file.name);
    const created = await run(() => api.upload(file));
    if (!created) return;
    const list = await api.listPackages();
    setPackages(list.result);
    setFixReport(undefined);
    const warnings = [...(created.warnings ?? [])];
    if (duplicate) {
      warnings.push(
        tr('같은 이름의 파일이 이미 열려 있습니다 — 둘 다 유지됩니다. 정리하려면 「파일 목록」에서 지우십시오.'),
      );
    }
    // 파일을 읽으며 서버가 알아챈 것(XML 판이었다 등)을 그대로 전한다 — 조용히 넘기지 않는다
    if (warnings.length > 0) setNotice(warnings.join(' · '));
    await loadPackage(created.packageId);
  };

  /**
   * 레퍼런스 번들 열기 — ZIP 하나로 공정과 설비가 함께 올라온다.
   * 🔴 해시가 manifest와 다르면 숨기지 않고 알린다. 「번들을 만든 뒤 파일이 바뀌었다」는 뜻이다.
   */
  const onOpenBundle = async (file: File): Promise<void> => {
    const opened = await run(() => api.openBundle(file));
    if (!opened) return;
    const list = await api.listPackages();
    setPackages(list.result);
    setFixReport(undefined);
    const fresh = opened.files.filter((f) => !f.reused).length;
    const verified = opened.files.filter((f) => f.hashOk === true).length;
    const head = fill(tr('번들 {0} v{1} — 파일 {2}개(새로 {3}) · 해시 일치 {4}/{5}'), { 0: opened.bundle.code ?? '', 1: opened.bundle.version ?? '?', 2: opened.files.length, 3: fresh, 4: verified, 5: opened.files.length });
    setNotice(opened.problems.length > 0 ? `${head} · ⚠ ${opened.problems.join(' · ')}` : head);
    if (opened.processPackageId) await loadPackage(opened.processPackageId);
  };

  /**
   * 견본으로 시작하기 — AASX가 한 장도 없는 사람의 첫걸음.
   *
   * 🔴 처음 받은 사람에게 「AASX 파일 열기」는 막다른 길이다 — 열 파일이 없다. 「새로 만들기」는
   *    빈 서브모델 여섯 개라 무엇을 채우는지 보이지 않는다. 다 채운 견본을 먼저 보여 준다.
   *    화면에 함께 실린 정적 파일(public/samples — scripts/make-samples.mjs)을 번들로 연다.
   *    같은 견본을 다시 눌러도 번들 열기가 해시로 알아보고 사본을 만들지 않는다.
   */
  const onOpenSample = async (): Promise<void> => {
    const name = 'RB01_OptimizationQuality_sample_bundle.zip';
    const data = await run(async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
      if (!response.ok) throw new Error(fill(tr('견본 파일을 받지 못했습니다 ({0}).'), { 0: response.status }));
      return response.blob();
    });
    if (!data) return;
    await onOpenBundle(new File([data], name, { type: 'application/zip' }));
    setNotice(
      tr('견본을 열었습니다 — 공정 구성(RB01)과 설비 1종(RollFormingMachine_sample ×2). 설비 줄을 누르면 그 설비 파일이 열립니다.'),
    );
  };

  /**
   * 구성 트리의 「PC에서 가져오기」 — 올리기만 하고 **화면은 그대로 둔다**.
   *
   * 🔴 `onUpload`와 갈라 둔 이유: 저쪽은 올린 파일을 곧바로 연다(loadPackage). 트리를 짜던
   *    중에 그러면 만들던 초안이 화면에서 사라진다. 여기서는 목록만 새로 읽어 후보에 넣고,
   *    고른 상태로 만드는 일은 트리 편집기가 한다.
   */
  const onImportForTree = async (file: File): Promise<string | undefined> => {
    const created = await run(() => api.upload(file));
    if (!created) return undefined; // 실패 메시지는 run()이 이미 띄웠다
    const list = await api.listPackages();
    setPackages(list.result);
    const warnings = created.warnings ?? [];
    if (warnings.length > 0) setNotice(warnings.join(' · '));
    return created.packageId;
  };

  /**
   * 목록에서 파일을 지운다.
   *
   * 🔴 지우기 전에 **다른 공정이 이 설비를 가리키고 있는지** 본다. 공정은 globalAssetId라는
   *    끈 하나로 설비를 가리킬 뿐이라, 설비를 지워도 공정 파일은 멀쩡해 보인다 —
   *    끊어진 사실이 화면 어디에도 안 나타난다. 그래서 지우기 전에 알려 준다.
   */
  /**
   * 처음 화면으로 — 로고를 누르면 돌아간다(웹의 관습, 2026-08-26 사용자 요청).
   * 파일은 그대로 두고 보던 것만 내려놓는다 — 다시 고르면 이어서 작업된다.
   */
  const goHome = (): void => {
    setSelectedKey(undefined);
    setAdding(undefined);
    setFilesOpen(false);
    setHistoryFor(undefined);
    setPackageId(undefined);
    setSubmodels([]);
    setShells([]);
    setConcepts([]);
    setFindings([]);
    setHierarchy(undefined);
    setLinked([]);
    setNotice(undefined);
    setFixReport(undefined);
    setError(undefined);
    openedRef.current = undefined;
  };

  /**
   * 파일을 목록에서 지운다 — 하나든 여럿이든 한 길(체크 박스 일괄 지우기, 사용자 2026-09-09).
   * 🔴 지우는 것끼리는 "가리키고 있다"로 세지 않는다 — 공정과 그 설비를 한꺼번에 지우는 것이 보통이다.
   *    가리키는 자리는 공정 층 밑까지 본다(전엔 맨 윗단만 봐서 층 밑 설비를 놓쳤다).
   */
  const deletePackages = async (ids: readonly string[]): Promise<void> => {
    const gone = new Set(ids);
    const targets = packages.filter((item) => gone.has(item.packageId));
    if (targets.length === 0) return;

    const mentions = (nodes: readonly HierarchyNode[], assetId: string): boolean =>
      nodes.some((child) => child.globalAssetId === assetId || mentions(child.children, assetId));
    const warnings: string[] = [];
    for (const target of targets) {
      if (!target.globalAssetId) continue;
      const users: string[] = [];
      for (const other of packages) {
        if (gone.has(other.packageId)) continue;
        try {
          const view = await api.hierarchy(other.packageId);
          if (mentions(view.children, target.globalAssetId)) {
            users.push(other.assetName ?? other.name ?? other.packageId);
          }
        } catch {
          // 계층이 없는 파일이다 — 가리킬 수가 없으므로 넘어간다
        }
      }
      if (users.length > 0) {
        warnings.push(fill(tr('{0}: {1}이(가) 가리키고 있습니다'), { 0: target.assetName ?? target.name ?? target.packageId, 1: users.join(' · ') }));
      }
    }

    const labels = targets.map((item) => `「${item.name ?? item.packageId}」`);
    const head =
      targets.length === 1
        ? fill(tr('{0}을(를) 목록에서 지웁니다.'), { 0: labels[0] })
        : fill(tr('파일 {0}건을 목록에서 지웁니다:\n{1}\n'), { 0: targets.length, 1: labels.join('\n') });
    const warning = warnings.length > 0 ? fill(tr('\n\n주의: {0}. 지우면 그 연결이 끊어집니다.'), { 0: warnings.join('\n') }) : '';
    if (!window.confirm(fill(tr('{0} 되돌릴 수 없습니다.{1}'), { 0: head, 1: warning }))) return;

    // 하나가 실패해도 그 앞까지는 지워졌다 — 목록은 반드시 다시 읽는다
    const done = await run(async () => {
      for (const target of targets) await api.deletePackage(target.packageId);
      return true;
    });
    const list = await api.listPackages();
    setPackages(list.result);
    setPickedFiles(new Set());
    if (!done) return;
    setNotice(targets.length === 1 ? fill(tr('{0}을(를) 지웠습니다.'), { 0: labels[0] }) : fill(tr('파일 {0}건을 지웠습니다.'), { 0: targets.length }));
    // 보던 파일이 살아 있으면 그대로 둔다
    if (!packageId || !gone.has(packageId)) return;
    const next = list.result[0];
    if (next) {
      await loadPackage(next.packageId);
    } else {
      // 남은 것이 없다 — 첫 화면으로 돌아간다
      setPackageId(undefined);
      setSubmodels([]);
      setShells([]);
      setConcepts([]);
      setFindings([]);
      setHierarchy(undefined);
      openedRef.current = undefined;
    }
  };
  const onDeletePackage = (targetId?: string): Promise<void> => {
    const wanted = targetId ?? packageId;
    return wanted ? deletePackages([wanted]) : Promise.resolve();
  };

  /**
   * 새로 만들기(설비 한 대 또는 공정) — 뼈대는 서버가 만든다(규약은 린터 정책 한 곳에만 둔다).
   * 만들자마자 규칙 위반 0건이어야 한다.
   */
  const onCreatePackage = async (
    assetName: string,
    extraSubmodels: string[],
    unit: 'equipment' | 'composite' = 'equipment',
    tree: DraftNode[] = [],
  ): Promise<void> => {
    const created = await run(async () => {
      const made = await api.createPackage(assetName, extraSubmodels, unit);
      // 🔴 그린 구성을 **만들면서 바로** 넣는다. 빈 공정을 먼저 보여 주면 "이제 뭘 해야 하나"에서 막힌다 —
      //    공정은 구성이 곧 정체다. 하나가 실패해도 나머지는 넣고, 어느 것이 안 됐는지 아래에서 알려 준다.
      //    부모 먼저 순서로 돌면 중첩(회사>공정>라인>설비)도 그대로 들어간다 — 서버는 어느 깊이든 parentPath를 받는다
      const failed: string[] = [];
      let total = 0;
      const iri = policy?.iriBase ?? 'https://www.smart-factory.kr/ids';
      const put = async (nodes: DraftNode[], parentPath: string[]): Promise<void> => {
        for (const node of nodes) {
          total += 1;
          const at = parentPath.length > 0 ? { parentPath } : {};
          if (node.kind === 'group') {
            try {
              await api.addHierarchyNode(made.packageId, { name: node.name, group: true, ...at });
              await put(node.children, [...parentPath, node.name]);
            } catch {
              failed.push(node.name);
            }
          } else if (node.kind === 'file' && node.packageId) {
            const item = packages.find((p) => p.packageId === node.packageId);
            if (node.split && node.count > 1) {
              // 호기별 — ×n 대신 **원본을 복제한 파일**(이름_1…_n)을 각각 잇는다.
              // 이름만 단 빈 마디를 넣으면 원본의 서브모델이 안 딸려온다(실측 제보 2026-08-27)
              const base = item?.assetName ?? item?.name?.replace(/\.aasx$/i, '') ?? 'Unit';
              for (let n = 1; n <= node.count; n += 1) {
                const unitName = `${base}_${n}`;
                try {
                  const existing = packages.find((p) => p.assetName === unitName);
                  const clone = existing ?? (await api.clonePackage(node.packageId, unitName));
                  await api.addHierarchyNode(made.packageId, { sourcePackageId: clone.packageId, ...at });
                } catch {
                  failed.push(unitName);
                }
              }
              continue;
            }
            try {
              await api.addHierarchyNode(made.packageId, {
                sourcePackageId: node.packageId,
                ...(node.count > 1 ? { bulkCount: node.count } : {}),
                ...at,
              });
            } catch {
              failed.push(node.name);
            }
          } else {
            // 아직 파일이 없는 설비 — 이름만 받고 Asset 주소는 규약으로 짓는다.
            // 나중에 같은 이름으로 설비 파일을 만들면 주소가 일치해 끈이 저절로 이어진다
            try {
              await api.addHierarchyNode(made.packageId, {
                name: node.name,
                globalAssetId: `${iri}/asset/${node.name}/1/0`,
                ...at,
              });
            } catch {
              failed.push(node.name);
            }
          }
        }
      };
      await put(tree, []);
      return { made, failed, total };
    });
    if (!created) return;
    const { failed } = created;
    setAdding(undefined);
    setFixReport(undefined);
    const list = await api.listPackages();
    setPackages(list.result);
    const orgLabel = tr('묶음');
    setNotice(
      unit !== 'equipment'
        ? failed.length > 0
          ? fill(tr('새 {0} 「{1}」을(를) 만들었습니다. 다만 {2}은(는) 넣지 못했습니다 — 아래에서 다시 넣으십시오.'), { 0: orgLabel, 1: assetName, 2: failed.join(' · ') })
          : created.total > 0
            ? fill(tr('새 {0} 「{1}」을(를) {2}건과 함께 만들었습니다.'), { 0: orgLabel, 1: assetName, 2: created.total })
            : fill(tr('새 {0} 「{1}」을(를) 만들었습니다. 아래 구성 트리의 「＋ 공정」「＋ 설비」로 넣으십시오.'), { 0: orgLabel, 1: assetName })
        : fill(tr('새 설비 「{0}」을(를) 만들었습니다. 대표 사진은 임시 그림이니 실제 사진으로 바꾸십시오.'), { 0: assetName }),
    );
    await loadPackage(created.made.packageId);
  };

  const onSelectFinding = (finding: Finding): void => {
    // 지적이 가리키는 요소까지 가는 길을 전부 펼친다 — 접혀 있으면 보이지 않는다
    const path = revealPath(roots, finding.pointer);
    if (path.target === undefined) return; // 트리에 자리가 없는 지적(있으면 안 되지만 방어)
    setExpanded(new Set([...expanded, ...path.keys]));
    setReveal(path.target);
    setSelectedKey(path.target);
  };

  /**
   * 이 노드를 저장할 파일 — ⚙ 가지(다른 파일의 요소)면 **그 파일이 원본**이므로 거기에 쓴다.
   * 🔴 보기 전용을 풀면서 정한 원칙: 화면은 이어 붙였어도 저장은 반드시 원본 파일로 간다.
   *    revision도 그 파일 것을 쓴다 — 남의 파일이라고 충돌 보호를 빼면 안 된다.
   */
  const targetOf = (node: TreeNode): { pid: string; revision: number | undefined } =>
    node.linkedPackageId !== undefined
      ? {
          pid: node.linkedPackageId,
          revision: linkedRevisions[node.linkedPackageId]?.[node.submodelId],
        }
      : { pid: packageId!, revision: revisions[node.submodelId] };

  /**
   * valueType 변경 — 요소 통째 교체(PUT). $value 경로로는 타입을 못 바꾼다.
   * 🔴 추가할 때 안 정하면 xs:string으로 박히는데 바꿀 길이 없었다(실사용 검증에서 확인).
   */
  const onChangeValueType = async (node: TreeNode, valueType: string): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const { pid, revision } = targetOf(node);
    const content = { ...(node.node as Record<string, unknown>), valueType };
    const done = await run(async () => {
      await api.putElement(pid, node.submodelId, node.idShortPath!, content, revision);
      return true;
    });
    if (done) await loadPackage(packageId);
  };

  /**
   * 값 표 저장 — 서브모델 JSON에 바뀐 값을 얹어 **한 번의 PATCH**로 보낸다.
   * 줄마다 patchValue를 부르면 revision이 어긋나 두 번째부터 409가 난다.
   */
  const onBulkSaveValues = async (
    node: TreeNode,
    content: Record<string, unknown>,
  ): Promise<void> => {
    if (!packageId) return;
    const { pid, revision } = targetOf(node);
    const done = await run(async () => {
      await api.patchSubmodel(pid, node.submodelId, content, revision);
      return true;
    });
    if (!done) return;
    setNotice(tr('값을 저장했습니다.'));
    await loadPackage(packageId);
  };

  /** 서브모델 이력 열기 — 실수를 되돌리는 길 */
  const onShowHistory = async (node: TreeNode): Promise<void> => {
    if (!packageId) return;
    const entries = await run(() => api.history(packageId, node.submodelId));
    if (!entries) return;
    setHistoryEntries(entries.result);
    setHistoryFor({ submodelId: node.submodelId, label: node.label });
    setSelectedKey(undefined); // 편집기를 비켜 준다 — 이력이 그 자리에 나온다
  };

  const onRestore = async (changedAt: string): Promise<void> => {
    if (!packageId || !historyFor) return;
    if (!window.confirm(fill(tr('{0} 판으로 되돌립니다. 되돌리기 자체도 이력에 남습니다.'), { 0: localTime(changedAt) }))) return;
    const done = await run(async () => {
      await api.restore(packageId, historyFor.submodelId, changedAt);
      return true;
    });
    if (!done) return;
    setHistoryFor(undefined);
    await loadPackage(packageId);
    setNotice(tr('되돌렸습니다. 이 되돌리기도 이력에 남아 다시 되돌릴 수 있습니다.'));
  };

  const onSave = async (node: TreeNode, value: unknown): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const { pid, revision } = targetOf(node);
    const done = await run(async () => {
      await api.patchValue(pid, node.submodelId, node.idShortPath!, value, revision);
      return true;
    });
    // 저장 결과는 서버에서 다시 읽어 확인한다 — 화면 상태를 믿지 않는다
    if (done) await loadPackage(packageId);
  };

  /** 요소 추가 — 부모가 Submodel이면 바로 아래, 아니면 그 요소 아래에 붙인다 */
  /**
   * 공정에 설비를 넣는다.
   *
   * 🔴 고른 파일에서 이름과 Asset 주소를 **서버가 읽는다.** 화면이 옮겨 적지 않는 이유는
   *    그 값이 두 파일을 잇는 유일한 끈이기 때문이다 — 틀리면 조용히 끊긴다.
   */
  const onAddHierarchyNode = async (
    sourcePackageId: string,
    bulkCount = 1,
    parentPath: string[] = [],
  ): Promise<void> => {
    if (!packageId) return;
    const added = await run(() =>
      api.addHierarchyNode(packageId, {
        sourcePackageId,
        ...(bulkCount > 1 ? { bulkCount } : {}),
        ...(parentPath.length > 0 ? { parentPath } : {}),
      }),
    );
    if (!added) return;
    await loadPackage(packageId);
    // 🔴 수집 연결(AID)이 있는 설비를 ×n으로 넣으면, 그 값은 "그중 한 대"의 것일 뿐이다.
    //    대별 가동값이 목적이면 파일을 나눠야 한다 — 도구가 이 함정을 알아채고 말해 준다
    //    (2026-08-26 사용자 질문에서 확정된 Type/Instance 경계)
    let caution = '';
    if (bulkCount > 1) {
      const hasAid = await api
        .submodels(sourcePackageId)
        .then((list) => list.result.some((sm) => sm.idShort === 'AssetInterfacesDescription'))
        .catch(() => false);
      if (hasAid) {
        caution = fill(
          tr(' 주의: 이 설비에는 수집 연결(AID)이 있습니다 — ×{0}로 넣으면 수집값이 어느 대의 것인지 구분되지 않습니다. 대별 가동값이 목적이면 대마다 파일을 나누십시오.'),
          { 0: bulkCount },
        );
      }
    }
    setNotice(
      (parentPath.length > 0
        ? fill(tr('「{0}」을(를) {1} 밑에 넣었습니다.'), { 0: added.name, 1: parentPath.join(' → ') })
        : fill(tr('「{0}」을(를) 넣었습니다.'), { 0: added.name })) + caution,
    );
  };

  /**
   * 호기별로 나눠 넣기 — ×n 대신 **원본을 복제한 파일**(이름_1…이름_n)을 각각 잇는다.
   * 각 호기는 서로 다른 개체라 복제 시 id·Asset 주소가 호기 이름으로 개명된다.
   * 원본의 주소를 같이 쓰면 안 된다 — "같은 자산이 n번"이라는 모순이 된다.
   */
  const onAddHierarchySplit = async (
    sourcePackageId: string,
    count: number,
    parentPath: string[],
  ): Promise<void> => {
    if (!packageId) return;
    const source = packages.find((item) => item.packageId === sourcePackageId);
    const base = source?.assetName ?? source?.name?.replace(/\.aasx$/i, '') ?? 'Unit';
    const failed: string[] = [];
    for (let unit = 1; unit <= count; unit += 1) {
      const name = `${base}_${unit}`;
      try {
        const existing = packages.find((p) => p.assetName === name);
        const clone = existing ?? (await api.clonePackage(sourcePackageId, name));
        await api.addHierarchyNode(packageId, {
          sourcePackageId: clone.packageId,
          ...(parentPath.length > 0 ? { parentPath } : {}),
        });
      } catch {
        failed.push(name);
      }
    }
    const list = await api.listPackages();
    setPackages(list.result);
    await loadPackage(packageId);
    setNotice(
      failed.length > 0
        ? fill(tr('호기별로 넣다 실패: {0}'), { 0: failed.join(' · ') })
        : fill(tr('{0}_1 … _{1} 파일을 복제해 나눠 넣었습니다 — 서브모델까지 그대로 담겨 있습니다. 호기마다 값·수집 주소를 따로 고치면 됩니다.'), { 0: base, 1: count }),
    );
  };

  /** 파일 없는 중간 마디 — 회사 파일 안의 「용접공정」. 이걸로 회사>공정>장비를 한 파일에 그린다 */
  const onAddHierarchyGroup = async (name: string, parentPath: string[]): Promise<void> => {
    if (!packageId) return;
    const added = await run(() =>
      api.addHierarchyNode(packageId, {
        name,
        group: true,
        ...(parentPath.length > 0 ? { parentPath } : {}),
      }),
    );
    if (!added) return;
    await loadPackage(packageId);
    setNotice(fill(tr('공정 「{0}」을(를) 만들었습니다. 그 줄의 「＋ 설비」로 설비를 넣으십시오.'), { 0: name }));
  };

  const onAddHierarchyManual = async (
    name: string,
    globalAssetId: string,
    bulkCount: number,
    parentPath: string[] = [],
  ): Promise<void> => {
    if (!packageId) return;
    const added = await run(() =>
      api.addHierarchyNode(packageId, {
        name,
        globalAssetId,
        bulkCount,
        ...(parentPath.length > 0 ? { parentPath } : {}),
      }),
    );
    if (!added) return;
    await loadPackage(packageId);
    setNotice(fill(tr('「{0}」을(를) 넣었습니다.'), { 0: name }));
  };

  /** 🔴 뺄 때 관계도 함께 빠진다(서버가 한다). 하나만 지우면 짝이 안 맞는 파일이 된다 */
  const onRemoveHierarchyNode = async (name: string, parentPath: string[] = []): Promise<void> => {
    if (!packageId) return;
    if (!window.confirm(fill(tr('「{0}」을(를) 이 목록에서 뺍니다. 설비 파일 자체는 지워지지 않습니다.'), { 0: name }))) {
      return;
    }
    const done = await run(async () => {
      await api.removeHierarchyNode(packageId, name, parentPath);
      return true;
    });
    if (!done) return;
    await loadPackage(packageId);
    setNotice(fill(tr('「{0}」을(를) 뺐습니다.'), { 0: name }));
  };

  const onCreateElement = async (parent: TreeNode, content: Record<string, unknown>): Promise<void> => {
    if (!packageId) return;
    const { pid } = targetOf(parent);
    const done = await run(async () => {
      await api.createElement(pid, parent.submodelId, parent.idShortPath, content);
      return true;
    });
    if (!done) return;
    setAdding(undefined);
    setExpanded(new Set([...expanded, parent.key]));
    await loadPackage(packageId);
  };

  const onCreateSubmodel = async (content: Record<string, unknown>): Promise<void> => {
    if (!packageId) return;
    // ⚙ 설비 컨텍스트에서 왔으면 그 설비 파일에 만든다 — 원본은 그 파일이다
    const pid = submodelTarget?.pid ?? packageId;
    const done = await run(async () => {
      const targetShell =
        pid === packageId ? shell : (await api.shells(pid)).result[0];
      if (!targetShell) throw new Error(tr('대상 파일에 AAS가 없습니다.'));
      await api.createSubmodel(pid, content);
      // AAS의 submodels[]에 참조를 함께 넣는다 — 빠뜨리면 어디에도 매달리지 않은 서브모델이 된다
      await api.addSubmodelRef(pid, targetShell.id, String(content['id']));
      return true;
    });
    if (!done) return;
    setAdding(undefined);
    if (submodelTarget) {
      setNotice(fill(tr('「{0}」에 서브모델을 만들었습니다.'), { 0: submodelTarget.assetName }));
      setSubmodelTarget(undefined);
    }
    await loadPackage(packageId);
  };

  /**
   * 이름(idShort) 바꾸기.
   *
   * 요소는 통째로 PUT하고(부분 갱신으로는 이름을 못 바꾼다), 서브모델은 PATCH한다.
   * 🔴 이름이 바뀌면 그 아래 모든 요소의 경로가 바뀐다 — 그래서 저장 뒤 **서버에서 다시 읽는다.**
   * 선택도 새 경로로 옮겨 준다. 안 그러면 방금 고친 요소가 화면에서 사라진다.
   */
  const onRename = async (node: TreeNode, nextName: string): Promise<void> => {
    if (!packageId) return;
    const { pid, revision } = targetOf(node);
    const done = await run(async () => {
      if (node.modelType === 'Submodel') {
        await api.patchSubmodel(pid, node.submodelId, { idShort: nextName }, revision);
      } else {
        if (!node.idShortPath) return false;
        await api.putElement(
          pid,
          node.submodelId,
          node.idShortPath,
          { ...node.node, idShort: nextName },
          revision,
        );
      }
      return true;
    });
    if (!done) return;
    // 트리에서의 자리는 그대로이므로(순서가 바뀌지 않는다) 같은 위치를 다시 고른다
    setSelectedKey(node.key);
    setNotice(fill(tr('이름을 「{0}」(으)로 바꿨습니다.'), { 0: nextName }));
    await loadPackage(packageId);
  };

  /**
   * 첨부 붙이기 — HandoverDocumentation의 매뉴얼 PDF가 여기로 들어간다.
   * 서버가 패키지 파트를 만들고 File.value까지 함께 고치므로, 화면은 다시 읽기만 하면 된다.
   */
  const onUploadAttachment = async (node: TreeNode, file: File): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const done = await run(async () => {
      await api.putAttachment(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        file,
        targetOf(node).revision,
      );
      return true;
    });
    if (done) {
      setNotice(fill(tr('「{0}」을(를) 붙였습니다. 내려받기한 AASX 안에 함께 들어갑니다.'), { 0: file.name }));
      await loadPackage(packageId);
    }
  };

  const onDownloadAttachment = async (node: TreeNode, filename: string): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    await run(() =>
      api.downloadAttachment(targetOf(node).pid, node.submodelId, node.idShortPath!, filename),
    );
  };

  const onDeleteAttachment = async (node: TreeNode): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    if (!globalThis.confirm(tr('붙어 있는 파일을 지웁니다. 계속할까요?'))) return;
    const done = await run(async () => {
      await api.deleteAttachment(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        targetOf(node).revision,
      );
      return true;
    });
    if (done) await loadPackage(packageId);
  };

  /**
   * 수집 연결(AID) 지우기 — 연결을 잘못 만들었거나 더 안 쓸 때.
   * 서브모델과 AAS의 참조를 함께 지운다. 🔴 이미 쌓인 수집값(시계열)은 남는다 —
   * 연결을 끊는 것이지 기록을 태우는 게 아니다.
   *
   * 🔴 그리고 「자리도 함께 만들기」로 **모델에 세운 항목은 지우지 않는다.** 그건 이제
   *    모델의 일부이고, 사람이 값을 채웠을 수도 있어 우리가 판단해 태울 것이 아니다.
   *    다만 **그 사실을 묻는 자리에서 말해야 한다** — 안 그러면 다 지워진 줄 안다.
   */
  const onDeleteAid = async (): Promise<void> => {
    if (!packageId) return;
    const aid = submodels.find((submodel) => submodel.idShort === 'AssetInterfacesDescription');
    if (!aid) return;
    if (
      !globalThis.confirm(
        tr('수집 연결(AID)을 지웁니다.\n\n') +
          tr('· 이미 수집한 값(시계열)은 남습니다.\n') +
          tr('· 「자리도 함께 만들기」로 OperationalData에 세운 항목도 남습니다 —\n') +
          tr('  필요 없으면 트리에서 직접 지우십시오.\n\n계속할까요?'),
      )
    )
      return;
    const done = await run(async () => {
      await api.deleteSubmodel(packageId, aid.id);
      if (shell) await api.removeSubmodelRef(packageId, shell.id, aid.id).catch(() => undefined);
      return true;
    });
    if (done) {
      setNotice(tr('수집 연결을 지웠습니다.'));
      await loadPackage(packageId);
    }
  };

  /** semanticId는 $value로 못 고친다 — 요소 전체를 PUT한다 */
  const onSaveSemanticId = async (node: TreeNode, semanticId: string): Promise<void> => {
    if (!packageId) return;
    const reference = { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: semanticId }] };
    // 🔴 서브모델도 semanticId를 가진다(표준 템플릿 IRI — KOSMO가 거기까지 본다). 요소와 달리 PATCH다
    if (node.modelType === 'Submodel') {
      const done = await run(async () => {
        await api.patchSubmodel(targetOf(node).pid, node.submodelId, { semanticId: reference }, targetOf(node).revision);
        return true;
      });
      if (done) await loadPackage(packageId);
      return;
    }
    if (!node.idShortPath) return;
    const next = { ...node.node, semanticId: reference };
    const done = await run(async () => {
      await api.putElement(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        next,
        targetOf(node).revision,
      );
      return true;
    });
    if (done) await loadPackage(packageId);
  };

  /** 대표 사진 교체 — 임시 그림(/thumbnail.png)을 실제 장비 사진으로 */
  const onUploadThumbnail = async (file: File): Promise<void> => {
    if (!packageId || !shell) return;
    const done = await run(async () => {
      await api.putThumbnail(packageId, shell.id, file, shellRevisions[shell.id]);
      return true;
    });
    if (!done) return;
    setNotice(fill(tr('대표 사진을 「{0}」(으)로 바꿨습니다. 내려받기한 AASX에 함께 들어갑니다.'), { 0: file.name }));
    await loadPackage(packageId);
  };

  const onSaveAssetInformation = async (info: Record<string, unknown>): Promise<void> => {
    if (!packageId || !shell) return;
    const done = await run(async () => {
      await api.putAssetInformation(packageId, shell.id, info, shellRevisions[shell.id]);
      return true;
    });
    if (done) await loadPackage(packageId);
  };

  const onSaveConcept = async (concept: Record<string, unknown>): Promise<void> => {
    if (!packageId) return;
    const done = await run(async () => {
      await api.putConceptDescription(packageId, concept);
      return true;
    });
    if (!done) return;
    setNotice(fill(tr('용어 「{0}」의 정의를 저장했습니다.'), { 0: String(concept['idShort'] ?? concept['id']) }));
    await loadPackage(packageId);
  };

  const onImport = async (
    sourcePackageId: string,
    submodelId: string,
    onDuplicate: 'reject' | 'replace' | 'alongside' = 'reject',
  ): Promise<void> => {
    if (!packageId) return;
    const result = await run(() => api.importSubmodel(packageId, sourcePackageId, submodelId, onDuplicate));
    if (!result) return;
    setAdding(undefined);
    const sourceName = packages.find((item) => item.packageId === sourcePackageId)?.name ?? tr('원본 파일');
    setNotice(
      fill(tr('가져왔습니다: {0}'), { 0: result.submodelId }) +
        (result.replaced ? fill(tr(' · 같은 이름의 옛것 {0}건을 지웠습니다'), { 0: result.replaced.length }) : '') +
        (result.idShort ? fill(tr(' · 이름은 「{0}」로 두었습니다'), { 0: result.idShort }) : '') +
        (result.copiedConceptDescriptions > 0
          ? fill(tr(' · ConceptDescription {0}건 동반'), { 0: result.copiedConceptDescriptions })
          : '') +
        // 🔴 실전 검증(2026-09-07): 가져온 명판의 제조사·일련번호는 **원본 설비 것**인데 위반 0건이라
        //    다 된 줄 알기 쉽다. 값을 바꿔야 한다는 것을 여기서 말해 준다
        fill(tr(' — 값은 「{0}」의 것입니다. 트리에서 골라 이 설비 값으로 바꾸십시오.'), { 0: sourceName }),
    );
    await loadPackage(packageId);
  };

  const onDelete = async (node: TreeNode): Promise<void> => {
    if (!packageId) return;
    const what = node.modelType === 'Submodel' ? fill(tr('서브모델 {0}'), { 0: node.label }) : fill(tr('요소 {0}'), { 0: node.label });
    if (!globalThis.confirm(fill(tr('{0}을(를) 지웁니다. 잘못 지웠으면 「↶ 되돌리기」(Ctrl+Z)로 돌아옵니다.'), { 0: what }))) {
      return;
    }
    const done = await run(async () => {
      if (node.modelType === 'Submodel') {
        // 🔴 다른 파일의 서브모델 통째 삭제는 여기서 하지 않는다 — AAS 참조 정리까지
        //    그 파일 문맥에서 해야 한다. 요소 편집과 달리 파일 구조를 바꾸는 일이다
        if (node.linkedPackageId !== undefined) {
          setNotice(tr('다른 파일의 서브모델은 그 파일을 열어 지우십시오.'));
          return false;
        }
        if (shell) await api.removeSubmodelRef(packageId, shell.id, node.submodelId).catch(() => undefined);
        await api.deleteSubmodel(packageId, node.submodelId);
      } else {
        await api.deleteElement(targetOf(node).pid, node.submodelId, node.idShortPath!);
      }
      return true;
    });
    if (!done) return;
    setSelectedKey(undefined);
    await loadPackage(packageId);
  };

  /**
   * 순서 바꾸기·복제 — Package Explorer에 있고 우리에겐 없던 두 가지(2026-09-04 검토).
   * 트리 key는 JSON Pointer라 옮긴 뒤의 자리를 계산할 수 있다 — 마지막 마디의 번호만 바뀐다.
   */
  const shiftedKey = (key: string, by: number): string =>
    key.replace(/\/(\d+)$/, (_, n: string) => `/${Number(n) + by}`);

  /** 형제 안에서 옮긴다 — `{offset}`은 한 칸(Alt+↑↓·메뉴), `{to}`는 끌어다 놓은 자리 */
  const onMove = async (node: TreeNode, move: { offset: -1 | 1 } | { to: number }): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const from = Number(/\/(\d+)$/.exec(node.key)?.[1] ?? NaN);
    const to = 'to' in move ? move.to : from + move.offset;
    if (Number.isNaN(from) || to === from || to < 0) return;
    const done = await run(async () => {
      await api.moveElement(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        move,
        targetOf(node).revision,
      );
      return true;
    });
    if (!done) return;
    setSelectedKey(shiftedKey(node.key, to - from));
    await loadPackage(packageId);
  };

  const onDuplicate = async (node: TreeNode): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const made = await run(() =>
      api.duplicateElement(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        targetOf(node).revision,
      ),
    );
    if (!made) return;
    setSelectedKey(shiftedKey(node.key, 1));
    setNotice(
      made.idShort
        ? fill(tr('「{0}」을(를) 「{1}」(으)로 복제했습니다 — 이름과 값을 고쳐 쓰십시오.'), { 0: node.label, 1: made.idShort })
        : fill(tr('「{0}」을(를) 바로 아래에 복제했습니다.'), { 0: node.label }),
    );
    await loadPackage(packageId);
  };

  /** 지금 한 번 수집한다(M8). 모델은 건드리지 않는다 */
  const onCollect = async (): Promise<void> => {
    if (!packageId) return;
    const cycle = await run(() => api.collect(packageId));
    if (!cycle) return;
    setLastCycle(cycle);
    const failed = cycle.interfaces.filter((entry) => entry.error).length;
    const badTags = cycle.interfaces.reduce(
      (sum, entry) => sum + (entry.report?.failures.length ?? 0),
      0,
    );
    setNotice(
      fill(tr('수집 {0}건'), { 0: cycle.collected }) +
        (failed > 0 ? fill(tr(' · 접속 실패 {0}건'), { 0: failed }) : '') +
        (badTags > 0 ? fill(tr(' · 나쁜 태그 {0}건'), { 0: badTags }) : ''),
    );
    const samples = await api.values(packageId).catch(() => undefined);
    if (samples) setValues(samples.result);
  };

  /**
   * 가상 PLC로 연결 — 설치판만 가진 사람이 번들을 재현하는 길(2026-09-30).
   * 🔴 파일에 수집 연결(AID)이 더해진다 — 제출 모델이면 시연본이 된다. 그래서 확인받는다
   */
  const onSimulate = async (): Promise<void> => {
    if (!packageId) return;
    if (
      !globalThis.confirm(
        tr('이 설비 파일에 가상 PLC(시뮬레이션) 수집 연결을 만듭니다.\n\n') +
          tr('· 파일에 AID 서브모델이 더해져 「시연본」이 됩니다.\n') +
          tr('· 제출할 참조모델을 그대로 두려면, 먼저 「호기별로 나누기」로 호기를 만들어 거기서 하십시오.\n\n계속할까요?'),
      )
    )
      return;
    const result = await run(() => api.simulate(packageId));
    if (!result) return;
    await loadPackage(packageId);
    setNotice(fill(tr('{0}에 연결했습니다 — 태그 {1}개. 한 번 수집합니다.'), { 0: result.title, 1: result.tags }));
    await onCollect();
  };

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

  /** 공정 화면에서 설비 하나를 가상 PLC에 붙이고 한 번 수집한다 — 공정 화면에 그대로 머문다 */
  const onSimulateEquipment = async (pid: string): Promise<void> => {
    if (!packageId) return;
    if (
      !globalThis.confirm(
        fill(tr('「{0}」에 가상 PLC(시뮬레이션) 수집 연결을 만듭니다.\n\n'), { 0: equipmentName(pid) }) +
          tr('· 그 설비 파일에 AID 서브모델이 더해져 「시연본」이 됩니다.\n') +
          tr('· 제출할 참조모델이면 먼저 「호기별로 나누기」로 호기를 만들어 거기서 하십시오.\n\n계속할까요?'),
      )
    )
      return;
    const result = await run(() => api.simulate(pid));
    if (!result) return;
    const cycle = await run(() => api.collect(pid));
    setNotice(fill(tr('「{0}」 {1}에 연결 — 태그 {2}개{3}'), { 0: equipmentName(pid), 1: result.title, 2: result.tags, 3: cycle ? fill(tr(' · 수집 {0}건'), { 0: cycle.collected }) : '' }));
    await loadPackage(packageId); // 연결 상태를 다시 그린다
  };

  const onCollectEquipment = async (pid: string): Promise<void> => {
    const cycle = await run(() => api.collect(pid));
    if (!cycle) return;
    const failed = cycle.interfaces.filter((entry) => entry.error).length;
    setNotice(fill(tr('「{0}」 수집 {1}건{2}'), { 0: equipmentName(pid), 1: cycle.collected, 2: failed > 0 ? fill(tr(' · 접속 실패 {0}건'), { 0: failed }) : '' }));
  };

  /** 현장 PLC — 그 설비 파일을 열고 「수집 연결 만들기」 창을 바로 띄운다(주소·태그 입력은 거기서) */
  const onConnectEquipment = async (pid: string): Promise<void> => {
    await loadPackage(pid);
    setAdding('aid');
  };

  /**
   * 되돌리기·다시 하기 — "실수했을 때 뒤로가기". 어떤 변경이든(값·삭제·순서·자동 고치기) 서버가
   * 직전 상태를 들고 있어 한 번에 돌아간다. 확인창은 띄우지 않는다 — 되돌리기는 그 자체가 되돌려진다
   */
  const onUndo = async (): Promise<void> => {
    if (!packageId || undoState.undo.length === 0) return;
    const result = await run(() => api.undo(packageId));
    if (!result) return;
    setNotice(fill(tr('되돌렸습니다: {0}. 잘못 눌렀으면 「다시 하기」.'), { 0: result.undone }));
    await loadPackage(packageId);
  };
  const onRedo = async (): Promise<void> => {
    if (!packageId || undoState.redo.length === 0) return;
    const result = await run(() => api.redo(packageId));
    if (!result) return;
    setNotice(fill(tr('다시 했습니다: {0}.'), { 0: result.redone }));
    await loadPackage(packageId);
  };

  /**
   * 「자동 고치기」 — 바로 고치지 않고 **미리보기 팝업**부터. 무엇이 어떻게 바뀌는지 항목별 전/후를 보여 주고
   * 체크한 것만 반영한다(사용자 2026-09-11 "자체 제작 형식으로 바꿔 버리고 끝이냐").
   */
  const onFix = async (): Promise<void> => {
    if (!packageId) return;
    // 공정(묶음)이면 이어 붙인 설비 파일까지 — 각 파일의 미리보기를 따로 받아 파일별로 보여 준다
    const targets = [
      {
        packageId,
        name: packages.find((item) => item.packageId === packageId)?.name ?? tr('이 파일'),
        self: true,
      },
      ...mounts.map((m) => ({ packageId: m.pid, name: m.name, self: false })),
    ];
    const plans = await run(async () => {
      const previews = await Promise.all(
        targets.map((t) => api.fixPreview(t.packageId).catch(() => undefined)),
      );
      const made: FixPlan[] = [];
      targets.forEach((t, i) => {
        const preview = previews[i];
        if (preview && preview.applied.length > 0) made.push({ ...t, preview });
      });
      return made;
    });
    if (!plans) return;
    setFixPlans(plans);
  };
  /**
   * 체크한 것만 반영 — **파일별로 나눠** 각자의 원본에 쓴다.
   * 🔴 한 파일이 실패해도 나머지는 계속한다. 중간에 멈추면 어디까지 갔는지 알 수 없다.
   */
  const onApplyFix = async (
    select: { packageId: string; ruleId: string; pointer: string }[],
  ): Promise<void> => {
    if (!packageId) return;
    setFixPlans(undefined);
    const byPackage = new Map<string, { ruleId: string; pointer: string }[]>();
    for (const item of select) {
      const list = byPackage.get(item.packageId) ?? [];
      list.push({ ruleId: item.ruleId, pointer: item.pointer });
      byPackage.set(item.packageId, list);
    }
    const failed: string[] = [];
    let mine: FixReport | undefined;
    let others = 0;
    await run(async () => {
      for (const [pid, picks] of byPackage) {
        try {
          const report = await api.fix(pid, picks);
          if (pid === packageId) mine = report;
          else others += report.applied.length;
        } catch {
          failed.push(mounts.find((m) => m.pid === pid)?.name ?? pid);
        }
      }
      return true;
    });
    if (mine) setFixReport(mine);
    if (others > 0 || failed.length > 0) {
      setNotice(
        fill(tr('연결 설비 파일에서 {0}건을 고쳤습니다'), { 0: others }) +
          (failed.length > 0 ? fill(tr(' — 다만 {0}는 고치지 못했습니다.'), { 0: failed.join(' · ') }) : '.'),
      );
    }
    await loadPackage(packageId);
  };
  /** 이관 대장의 원본 IRI로 되돌리기 — KOSMO 우선 정책이면 다시 위반으로 잡힌다. 규정 해석이 바뀌었을 때 쓰는 길 */
  const onRevertLedger = async (): Promise<void> => {
    if (!packageId) return;
    const count = Object.keys(ledger).length;
    if (
      !window.confirm(
        fill(tr('이관 대장의 {0}건을 IDTA 원본 IRI로 되돌립니다. 지금 정책(KOSMO 우선)이면 다시 위반으로 잡힙니다 — 규정 해석이 바뀌었을 때 쓰는 기능입니다. 잘못 눌렀으면 「↶ 되돌리기」.'), { 0: count }),
      )
    )
      return;
    const done = await run(() => api.revertRelocations(packageId));
    if (!done) return;
    setNotice(fill(tr('원본 IRI로 되돌렸습니다: {0}건.'), { 0: done.reverted.length }));
    await loadPackage(packageId);
  };

  /**
   * 🔴 위반이 남은 채로 내려받으면 KOSMO Validator에서 떨어진다. 막지는 않는다 —
   *    중간 저장도 내려받기다 — 다만 알고 받게 한다. 끝나면 어디로 갔는지 말해 준다
   *    (브라우저가 조용히 받아 「눌렀는데 아무 일도 없다」는 문의가 있었다).
   */
  const onDownload = async (): Promise<void> => {
    if (!packageId) return;
    if (
      errors > 0 &&
      !window.confirm(
        fill(tr('위반 {0}건이 남아 있습니다. 이대로 내려받으면 KOSMO Validator에서 떨어집니다.\n'), { 0: errors }) +
          tr('그래도 내려받을까요? (작업 중 저장이면 괜찮습니다)'),
      )
    )
      return;
    await run(() => api.download(packageId));
    setNotice(tr('AASX를 내려받았습니다 — 브라우저의 다운로드 폴더에 있습니다.'));
  };

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

  // 알림 띠는 저절로 사라진다 — 닫기를 누르지 않으면 한 시간 전 알림이 그대로 남아 있었다
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Esc — 열린 것부터 하나씩 닫는다. 아무것도 안 열려 있으면 선택을 내려놓는다
  // Ctrl/⌘+Z — 되돌리기, Shift를 더하면 다시 하기(입력 칸 안에서는 그 칸의 몫)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 입력 중인 칸의 Esc·Ctrl+Z는 그 칸의 몫이다(검색창 비우기·글자 되돌리기)
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !busy) {
        event.preventDefault();
        void (event.shiftKey ? onRedo() : onUndo());
        return;
      }
      if (event.key !== 'Escape') return;
      if (showFindings) setShowFindings(false);
      else if (showOpcua) setShowOpcua(false);
      else if (showRules) setShowRules(false);
      else if (adding) setAdding(undefined);
      else if (historyFor) setHistoryFor(undefined);
      else if (filesOpen) setFilesOpen(false);
      else if (selectedKey) setSelectedKey(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onUndo/onRedo는 매 렌더 새로 만들어진다; 상태는 그 안에서 읽는다
  }, [showFindings, showOpcua, showRules, adding, historyFor, filesOpen, selectedKey, busy, packageId, undoState]);

  /**
   * 구성 패널 — 공정 파일에서는 **요약 머리 바로 밑**에 온다(사용자 2026-09-08: "공정 만들고 하위에 설비
   * 등록하려면 안 되는데" — 폼이 타일·판정 아래 화면 밖에 있어 보이지 않았다). 공정 파일의 정체는 구성이다.
   * 설비 파일에서는 부품 구성이 부차적이라 예전처럼 요약 뒤에 둔다.
   */
  const hierarchyPanel =
    hierarchy?.entryNode && packageId ? (
            <Hierarchy
              t={t}
              key={packageId} // 파일을 바꾸면 열려 있던 넣기 폼도 접힌다(실측: 이전 파일의 폼이 따라왔다)
              view={hierarchy}
              unit={fileUnit}
              {...(hierAdder ? { adder: hierAdder } : {})}
              onAdderChange={setHierAdder}
              {...(policy ? { iriBase: policy.iriBase } : {})}
              candidates={packages.filter((item) => item.packageId !== packageId)}
              onImportFile={onImportForTree}
              busy={busy}
              onAdd={(source, count, parent) => void onAddHierarchyNode(source, count, parent)}
              onAddSplit={(source, count, parent) =>
                void onAddHierarchySplit(source, count, parent)
              }
              onAddManual={(name, assetId, bulk, parent) =>
                void onAddHierarchyManual(name, assetId, bulk, parent)
              }
              onAddGroup={(name, parent) => void onAddHierarchyGroup(name, parent)}
              onRemove={(name, parent) => void onRemoveHierarchyNode(name, parent)}
              // ㉯ 자식 설비의 서브모델을 그 자리에서 읽어 온다 — 파일 구조는 그대로다
              fetchSubmodels={async (id) => (await api.submodels(id)).result}
              onOpen={(id) => void loadPackage(id)}
            />
    ) : undefined;

  /*
    로그인 벽 — 세 갈래로 갈린다.
    🔴 `auth === undefined`는 "아직 모른다"다. 모르는 동안 로그인 화면을 띄우면
       이미 로그인한 사람에게 한 번 깜빡인다. 아무 것도 그리지 않고 기다린다.
    🔴 `authRequired`가 꺼진 서버(계정도 토큰도 없음)에서는 로그인 화면을 띄우지 않는다 —
       넣을 계정이 없어 아무도 들어갈 수 없게 된다(개발·설치판이 이 경우다).
    🔴 토큰(API 키)을 쥐고 있으면 그대로 쓴다 — 기존 사용자를 쫓아내지 않는다.
  */
  if (auth === undefined) return <div className="app" />;
  if (
    (auth.authRequired && !auth.authenticated && currentToken() === undefined) ||
    (startAccounts && (auth.setupNeeded || auth.signupAllowed === true))
  ) {
    return (
      <div className="app">
        <main className="login-wrap">
          {/* onCancel은 **스스로 들어온 사람에게만** 준다 — 갇힌 사람에게 「그만두기」는 뜻이 없다 */}
          <Login
            setupNeeded={auth.setupNeeded}
            setupCodeRequired={auth.setupCodeRequired === true}
            signupAllowed={auth.signupAllowed === true}
            startInSignup={startAccounts && !auth.setupNeeded}
            {...(auth.privacyUrl ? { privacyUrl: auth.privacyUrl } : {})}
            {...(auth.demo ? { demo: auth.demo } : {})}
            busy={busy}
            {...(startAccounts ? { onCancel: () => setStartAccounts(false) } : {})}
            t={t}
            onLogin={async (login, password) => {
              try {
                await api.login(login, password);
                await bootstrap();
                return undefined;
              } catch (caught) {
                return describeError(caught);
              }
            }}
            onSignup={async (login, password, displayName, email, company, agreed) => {
              try {
                await api.signup(login, password, displayName, email, company, agreed);
                setStartAccounts(false);
                await bootstrap();
                return undefined;
              } catch (caught) {
                return describeError(caught);
              }
            }}
            onSetup={async (login, password, displayName, setupCode) => {
              try {
                await api.setup(login, password, displayName, setupCode);
                setStartAccounts(false);
                await bootstrap();
                return undefined;
              } catch (caught) {
                return describeError(caught);
              }
            }}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        {/*
          두 줄이다. 윗줄은 **어느 파일을 보는가**와 상태, 아랫줄은 **그 파일에 무엇을 하는가**.
          아랫줄은 파일이 열려야 나온다 — 처음 화면에 눌러도 안 되는 버튼을 줄지어 두지 않는다.
        */}
        <div className="bar">
          {/* 회사 표시 — 화면·결과서·문서에 같은 로고가 들어간다 */}
          <span
            className="brand"
            title={tr('처음 화면으로')}
            onClick={goHome}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter') goHome();
            }}
          >
            {/*
              🔴 글자로 그린다(2026-10-02). 이름이 WACE → VEXPLOR로 바뀌었는데 **VEXPLOR 로고
                 그림이 없다.** 옛 그림을 그대로 두면 제목은 VEXPLOR인데 그림은 WACE라 어긋난다.
                 글자는 해상도를 안 타고, 이름이 또 바뀌어도 여기 한 줄만 고치면 된다.
                 공식 로고 파일을 받으면 <img>로 되돌린다.
            */}
            <span className="wordmark">VEXPLOR</span>
            <span className="product">AAS Studio</span>
            {/* 판 번호 — 배포처가 여럿이면 "어느 판인가"가 문의의 첫 질문이다 */}
            {version && <span className="version" title={tr('제품 판 번호')}>v{version}</span>}
          </span>

          <input
            ref={fileInput}
            type="file"
            accept=".aasx"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onUpload(file);
              event.target.value = '';
            }}
          />
          {/*
            🔴 파일 관련 네 가지를 한 메뉴로(2026-10-02). 전에는 「파일」 라벨 + 버튼 셋이
               펼쳐져 윗줄이 길었다. 파일을 여는 일은 **한 번 하고 마는 일**이라 접어도 된다 —
               자주 쓰는 것은 그 옆의 파일 고르개다.
          */}
          <Menu
            label={t('파일')}
            title={tr('열기 · 새로 만들기 · 번들 열기 · 파일 목록')}
            disabled={busy}
            items={[
              {
                label: t('AASX 열기'),
                title: tr('이 PC의 .aasx 파일을 올려 엽니다'),
                onClick: () => fileInput.current?.click(),
                disabled: busy,
              },
              {
                label: t('새로 만들기'),
                title: tr('빈 설비 또는 회사·공정 묶음을 새로 만듭니다'),
                onClick: () => setAdding('new'),
                disabled: busy,
              },
              {
                label: t('번들 열기'),
                title: tr('이 도구로 내보낸 레퍼런스 번들(.zip)을 엽니다 — 공정과 설비가 한 번에 올라옵니다'),
                onClick: () => bundleInput.current?.click(),
                disabled: busy,
              },
              {
                // 첫 화면에만 두면 파일이 하나라도 생긴 뒤에는 다시 못 연다 — 지운 견본을 되살릴 길도 여기다
                label: t('견본 열기'),
                title: tr('다 채워진 설비 1종과 공정 구성을 열어 둘러봅니다 — 고쳐도 되는 연습용입니다'),
                onClick: () => void onOpenSample(),
                disabled: busy,
              },
              {
                label: t('파일 목록'),
                title: tr('올려 둔 파일을 한눈에 보고 지웁니다'),
                onClick: () => {
                  setFilesOpen((current) => !current);
                  setPickedFiles(new Set());
                },
                disabled: busy || packages.length === 0,
                separated: true,
              },
            ]}
          />
          <input
            ref={bundleInput}
            type="file"
            accept=".zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onOpenBundle(file);
              event.target.value = '';
            }}
          />
          <select
            value={packageId ?? ''}
            disabled={busy || packages.length === 0}
            onChange={(event) => void loadPackage(event.target.value)}
          >
            {packages.length === 0 && <option value="">{t('열린 파일 없음')}</option>}
            {packages.length > 0 && !packageId && <option value="">{t('— 파일 고르기 —')}</option>}
            {packages.map((item) => (
              <option key={item.packageId} value={item.packageId}>
                {item.name ?? item.packageId}
              </option>
            ))}
          </select>

          {/* 오른쪽 — 상태 */}
          <span className="spacer" />
          {busy && <span className="busy">{t('처리 중…')}</span>}
          {packageId && (
            /* 눌러서 목록을 연다. 색만으로 나누지 않는다 — 점 + 글자 (색각 이상 대비) */
            <button
              className={`status chip ${errors === 0 ? 'ok' : 'bad'}`}
              onClick={() => setShowFindings(true)}
              title={tr('눌러서 지적 목록을 봅니다')}
            >
              <span className="dot" aria-hidden="true" />
              {t('위반')} {errors}{lang === 'ko' ? tr('건') : ''}
              <span className="sub"> · {t('경고')} {warnings}{lang === 'ko' ? tr('건') : ''}</span>
            </button>
          )}
          {/*
            🔴 **내주기**는 수집과 반대 방향이다. 전에는 수집 패널 안에 나란히 뒀는데,
               내보내기 주소가 수집 조작부 바로 옆에 떠 있어 사용자가 그 주소를
               「설비 주소」에 넣는 사고가 났다. 방향이 다른 것은 자리도 달라야 한다.
               처음 화면에서는 숨긴다 — 파일도 없는데 「내주는 중」은 무슨 뜻인지 물어 왔다.
          */}
          {packageId && opcua?.running && (
            <button
              className="status chip out"
              onClick={() => setShowOpcua(true)}
              title={tr('이 도구가 다른 시스템에 값을 내주고 있습니다')}
            >
              {t('→ 내주는 중')}
              <span className="sub">{' '}<T k={'· 변수 {0}개'} v={[opcua.variables]} /></span>
            </button>
          )}
          {/*
            🔴 설정(2026-10-02) — 늘 쓰는 것이 아닌데 헤더 자리를 차지하던 것들을 모았다.
               「규칙」은 하루에 한 번 볼까 말까고, 「토큰 지우기」는 자리를 뜰 때만 쓴다.
          */}
          <Menu
            // 🔴 톱니(⚙)를 쓰지 않는다 — 이 화면에서 ⚙는 트리의 **「설비」** 표시다.
            //    한 기호가 두 뜻이면 둘 다 흐려진다. 글자로 적는다(사용자 2026-10-04)
            label={t('설정')}
            align="right"
            title={t('설정 — 언어 · 계정 · 규칙')}
            items={[
              {
                label: fill(tr('언어 — {0}'), { 0: lang === 'en' ? 'English' : tr('한국어') }),
                title: tr('화면 글자의 언어를 고릅니다'),
                onClick: () => setShowSettings(true),
              },
              // 체험 계정으로 보고 있다 — 자기 계정을 만들면 내려받을 수 있다
              ...(auth?.demo !== undefined && auth.signupAllowed === true
                ? [
                    {
                      label: t('회원가입'),
                      title: t('계정을 만들면 작업한 파일을 내려받을 수 있습니다.'),
                      onClick: () => setStartAccounts(true),
                      separated: true,
                    },
                  ]
                : []),
              // 계정을 아직 안 쓰는 서버 — 여기서 시작한다
              ...(auth?.setupNeeded && !auth.authenticated
                ? [
                    {
                      label: t('첫 관리자 만들기'),
                      title: t('계정과 로그인을 쓰기 시작합니다 — 지금은 누구나 들어올 수 있습니다'),
                      onClick: () => setStartAccounts(true),
                      separated: true,
                    },
                  ]
                : []),
              // 계정 화면 — 내 비밀번호, 관리자면 사람들. 🔴 체험 계정에는 없다(바꿀 수 없는 계정이다)
              ...(auth?.user && auth.demo === undefined
                ? [
                    {
                      label: auth.user.role === 'admin' ? t('계정 관리') : t('내 비밀번호 바꾸기'),
                      title:
                        auth.user.role === 'admin'
                          ? t('사람을 더하고, 역할을 바꾸고, 잠급니다. 내 비밀번호도 여기서 바꿉니다')
                          : t('이 계정의 비밀번호를 바꿉니다'),
                      onClick: () => setShowAccounts(true),
                      separated: true,
                    },
                  ]
                : []),
              // 로그인한 사람 — 이름과 로그아웃을 같은 자리에
              ...(auth?.user
                ? [
                    {
                      label: `${auth.user.displayName} · ${t('로그아웃')}`,
                      title: tr('이 브라우저의 로그인을 끝냅니다'),
                      onClick: () => {
                        void api
                          .logout()
                          .catch(() => undefined)
                          .then(() => bootstrap());
                      },
                      separated: true,
                    },
                  ]
                : []),
              /*
               * 탈퇴 — 🔴 체험 계정에는 보이지 않는다(여럿이 쓰는 계정이라 서버도 거절한다).
               * 되돌릴 수 없으므로 한 번 묻는다. 지워도 **누가 고쳤나는 남는다** —
               * 그 이름은 사람 표를 참조하지 않고 그때 베껴 둔 값이다.
               */
              ...(auth?.user && auth.demo === undefined
                ? [
                    {
                      label: t('탈퇴 — 계정 지우기'),
                      title: t('이 계정을 지웁니다. 되돌릴 수 없습니다.'),
                      onClick: () => setConfirmQuit(true),
                    },
                  ]
                : []),
              {
                label: t('규칙과 규약 보기'),
                title: tr('이 도구가 지키는 규칙 43종과 규약을 지금 도는 그대로 보여 줍니다'),
                onClick: () => setShowRules(true),
                disabled: busy,
                separated: true,
              },
              ...(currentToken() !== undefined
                ? [
                    {
                      label: t('토큰 지우기'),
                      title: tr('이 브라우저에 저장된 접근 토큰을 지웁니다 — 공용 PC에서 자리를 뜰 때'),
                      onClick: () => {
                        setToken(undefined);
                        void bootstrap(); // 토큰이 사라졌으니 서버가 다시 물어 올 것이다
                      },
                    },
                  ]
                : []),
            ]}
          />
        </div>

        {packageId && (
          <div className="bar work">
            {/* 🔴 묶음마다 <span class="group"> — 좁은 창(1024px)에서 「AASX 내려받기」 하나만 셋째 줄로
                떨어져 ③ 제출이 흩어졌다(2026-09-09 실측). 묶음은 통째로 줄을 바꾼다 */}
            {/* 편집 — 파일 안을 바꾸는 동작들. 맨 앞은 뒤로가기 — 실수를 한 번에 되돌린다 */}
            {/*
              🔴 「① 편집 ② 검사 ③ 제출」 라벨을 걷었다(2026-10-02 사용자 요청). 라벨이 자리를
                 먹었고, 번호가 "순서대로 해야 한다"는 오해를 줬다 — 실제로는 고치고 검사하고
                 또 고치며 왔다 갔다 한다. 묶음은 **구분선**으로만 가른다.
              🔴 접는 기준은 **쓰는 빈도**다. 매번 누르는 것(되돌리기·자동 고치기·내려받기)은
                 밖에 두고, 가끔 쓰는 것만 메뉴로 넣는다. 한 번 더 누르게 만드는 것은
                 그만한 값을 해야 한다.
            */}
            <span className="group">
            <button
              className="undo"
              onClick={() => void onUndo()}
              disabled={busy || undoState.undo.length === 0}
              aria-label={tr('되돌리기')}
              title={
                undoState.undo[0]
                  ? fill(tr('되돌리기: {0} (Ctrl+Z){1}'), { 0: undoState.undo[0], 1: undoState.undo.length > 1 ? fill(tr(' · {0}단계 남음'), { 0: undoState.undo.length }) : '' })
                  : tr('되돌릴 변경이 없습니다')
              }
            >
              {t('↶ 되돌리기')}
            </button>
            <button
              className="undo"
              onClick={() => void onRedo()}
              disabled={busy || undoState.redo.length === 0}
              aria-label={tr('다시 하기')}
              title={undoState.redo[0] ? fill(tr('다시 하기: {0} (Ctrl+Shift+Z)'), { 0: undoState.redo[0] }) : tr('다시 할 변경이 없습니다')}
            >
              ↷
            </button>
            <span className="sep-line" aria-hidden="true" />
            {/* 🔴 이름을 「서브모델」로 — 「추가」는 요소 추가 폼의 버튼과 겹쳐 무엇을 더하는지 모호했다 */}
            <Menu
              label={t('서브모델')}
              title={tr('이 파일에 서브모델을 넣습니다')}
              disabled={busy}
              items={[
                {
                  label: t('서브모델 추가'),
                  title: tr('이 설비에 새 서브모델을 만듭니다 — id는 규약대로 지어집니다'),
                  onClick: () => setAdding('submodel'),
                  disabled: busy || !shell,
                },
                {
                  label: t('다른 파일에서 가져오기'),
                  title: tr('다른 AASX의 서브모델을 통째로 복사합니다 — 용어(CD)도 함께 옵니다'),
                  onClick: () => setAdding('import'),
                  disabled: busy,
                },
              ]}
            />
            <span className="sep-line" aria-hidden="true" />
            {/*
              🔴 한 화면에 파란 버튼은 하나다 — 그것이 「다음에 누를 것」이다.
                 고칠 것이 있으면 자동 고치기, 다 고쳤으면 내려받기.
            */}
            <button
              className={fixable > 0 ? 'primary' : ''}
              onClick={() => void onFix()}
              disabled={busy || fixable === 0}
              title={
                fixable === 0
                  ? unfixable > 0
                    ? fill(tr('자동으로 고칠 지적이 없습니다 — {0}건은 사람이 판단할 몫입니다(지적 목록 참조)'), { 0: unfixable })
                    : tr('자동으로 고칠 지적이 없습니다')
                  : linkedFixable > 0
                    ? tr('고칠 수 있는 지적을 규약대로 교정합니다 — 설비 파일 것은 그 설비 파일에 저장됩니다')
                    : tr('고칠 수 있는 지적(경고 포함)을 규약대로 자동 교정합니다')
              }
            >
              {t('자동 고치기')}{fixable > 0 ? ` ${fixable}${lang === 'ko' ? tr('건') : ''}` : ''}
            </button>
            </span>

            {/* 마지막 단계는 오른쪽 끝에 — 끝내는 동작은 늘 같은 자리에 있어야 손이 기억한다 */}
            <span className="spacer" />
            <span className="group submit">
            <Menu
              label={t('뽑아내기')}
              align="right"
              title={tr('제출·문서에 붙일 자료를 뽑습니다')}
              disabled={busy}
              items={[
                {
                  label: t('검증 결과서'),
                  title: tr('검사 결과를 인쇄용으로 엽니다 — 인쇄하면 그대로 제출용 PDF가 됩니다'),
                  onClick: () => void run(() => api.openReport(packageId)),
                },
                {
                  label: t('문서용 자료'),
                  title: tr('가이던스에 붙일 UML 그림과 표를 뽑습니다'),
                  onClick: () => setAdding('docs'),
                  disabled: busy,
                },
                ...(fileUnit === 'composite'
                  ? [
                      {
                        label: t('레퍼런스 번들'),
                        title: tr('이 공정을 제출 꾸러미(ZIP)로 봅니다 — 구성·준비 상태·데이터 연계'),
                        onClick: () => setAdding('bundle'),
                        disabled: busy,
                        separated: true,
                      },
                    ]
                  : []),
              ]}
            />
            {/* 🔴 체험 계정은 눌러도 403이다. 눌러 보고 알게 하는 것보다 **왜 안 되는지**를
                먼저 말하는 편이 낫다 — 단추는 남겨 두고 설명을 바꾼다(없으면 「받는 기능이
                없는 도구」로 보인다) */}
            <button
              className={!demoLocked && fixable === 0 && errors === 0 ? 'primary' : ''}
              onClick={() => (demoLocked ? setStartAccounts(true) : void onDownload())}
              disabled={busy}
              title={
                demoLocked
                  ? t('체험 계정으로는 내려받을 수 없습니다 — 눌러서 계정을 만드십시오.')
                  : errors > 0
                    ? fill(tr('위반 {0}건이 남아 있습니다 — 받을 수는 있지만 KOSMO 제출은 아직입니다'), { 0: errors })
                    : tr('KOSMO 제출용 .aasx로 내려받습니다')
              }
            >
              {demoLocked ? `🔒 ${t('AASX 내려받기')}` : t('AASX 내려받기')}
            </button>
            </span>
          </div>
        )}
      </header>

      {/* 탈퇴 확인 — 되돌릴 수 없다. 무엇이 남고 무엇이 사라지는지 적는다 */}
      {confirmQuit && (
        <div className="demo-bar" role="alertdialog">
          ⚠️ <b>{t('정말 탈퇴하시겠습니까?')}</b>{' '}
          {t('계정과 연락처가 지워집니다. 올린 파일과 변경 이력은 서버에 그대로 남습니다.')}{' '}
          <button
            className="link"
            onClick={() => {
              setConfirmQuit(false);
              void api
                .deleteMe()
                .then(() => bootstrap())
                .catch((caught: unknown) => setError(describeError(caught)));
            }}
          >
            {t('탈퇴합니다')}
          </button>{' '}
          <button className="link" onClick={() => setConfirmQuit(false)}>
            {t('그만두기')}
          </button>
        </div>
      )}

      {/*
        체험판 띠 — 무엇이 막혀 있고 올린 것이 어떻게 되는지를 먼저 말한다.
        🔴 처음에는 「다른 사람에게도 보입니다」였다. 작업 공간을 로그인마다 가른 뒤로는
           사실이 아니다(2026-10-04). 대신 **로그인을 새로 하면 빈 칸에서 시작한다**는 것을
           적는다 — 체험 계정은 로그인이 곧 작업 공간이라, 모르면 「파일이 사라졌다」가 된다.
      */}
      {demoLocked && (
        <div className="demo-bar">
          🧪 <b>{t('체험판입니다')}</b> —{' '}
          {t('올린 파일은 다른 방문자에게 보이지 않습니다. 한동안 쓰지 않으면 지워지고, 로그인을 새로 하면 빈 칸에서 시작합니다.')}{' '}
          <button className="link" onClick={() => setStartAccounts(true)}>
            {t('회원가입하면 내려받을 수 있습니다')}
          </button>
        </div>
      )}

      {/* 오류는 헤더 안이 아니라 아래 띠로 — 헤더 안에 있으면 버튼을 밀어내며 줄이 꺾였다 */}
      {error && (
        <div className="error-bar" role="alert">
          {error}
          <button className="link" onClick={() => setError(undefined)}>
            {tr('닫기')}
          </button>
        </div>
      )}

      {needsToken !== undefined && (
        <form
          className="token-bar"
          onSubmit={(event) => {
            event.preventDefault();
            const input = new FormData(event.currentTarget).get('token');
            setToken(typeof input === 'string' ? input : undefined);
            setNeedsToken(undefined);
            // 새로고침하지 않는다 — 편집하다 토큰이 만료된 경우 화면을 잃지 않아야 한다
            void bootstrap();
          }}
        >
          <b>{tr('접근 토큰이 필요합니다.')}</b> {tr('관리자에게 받은 토큰을 넣어 주세요.')} {needsToken}
          <input
            name="token"
            type="password"
            placeholder={tr('토큰')}
            autoComplete="off"
            autoFocus
          />
          <button className="primary" type="submit">
            {tr('확인')}
          </button>
        </form>
      )}

      {conflict && (
        <div className="conflict">
          {/* 화면의 값을 밀어 넣지 않는다 — 남의 편집을 덮어쓰는 게 가장 나쁜 결과다 */}
          {tr('다른 곳에서 이 서브모델이 먼저 바뀌었습니다.')} <b>{tr('내 수정은 저장하지 않았습니다.')}</b>{' '}
          {conflict}
          <button
            className="link"
            title={tr('서버에 저장된 최신 내용을 다시 읽어 옵니다 — 내가 고치던 것은 사라집니다')}
            onClick={() => {
              if (packageId) void loadPackage(packageId);
            }}
          >
            {tr('다시 읽기')}
          </button>
        </div>
      )}

      {notice && (
        <div className="notice">
          {notice}
          <button className="link" onClick={() => setNotice(undefined)}>
            {tr('닫기')}
          </button>
        </div>
      )}

      {fixReport && (
        <div className="fix-report">
          <T k={'교정 {0}건({1}바퀴) · 남은 위반 {2}건'} v={[fixReport.applied.length, fixReport.rounds, fixReport.after.countBySeverity.error]} />
          {Object.keys(fixReport.relocations).length > 0 && (
            <>{' '}<T k={'· 이관 대장 {0}건'} v={[Object.keys(fixReport.relocations).length]} /></>
          )}
          <button className="link" onClick={() => setFixReport(undefined)}>
            {tr('닫기')}
          </button>
        </div>
      )}

      {/* 규칙·규약 — 지적 목록·내주기와 같은 팝업. 예전엔 헤더 밑 띠로 끼어들어 본문을 밀어냈다(2026-09-09 디자인 검토) */}
      {showRules && (
        <div className="modal-back" role="presentation" onClick={() => setShowRules(false)}>
          <div
            className="modal rules-modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr('규칙과 규약')}
            onClick={(event) => event.stopPropagation()}
          >
            <Rules onClose={() => setShowRules(false)} />
          </div>
        </div>
      )}

      {/*
        🔴 칸 너비를 inline style로 준다. 첫 화면(welcome)일 때도 같은 값을 주지만
           `.welcome`이 `grid-column: 1 / -1`이라 통째로 쓰므로 영향이 없다.
      */}
      <main ref={mainRef} style={{ gridTemplateColumns: gridTemplate(shownPanes) }}>
        {/*
          🔴 「새로 만들기」가 열려 있는 동안은 busy여도 첫 화면을 지킨다. 전에는 첫 화면에서 「PC에서 가져오기」로
             파일을 올리는 순간 busy → 세 칸 화면으로 갈아타며 NewPackage가 **언마운트**돼 만들던 공정·설비 트리가
             통째로 사라졌다(사용자 2026-09-09 "적용 안 되고 나가짐"). !busy 조건은 첫 파일을 여는 동안 첫 화면이
             깜빡이지 않게 둔 것이라, 만들기 폼이 열려 있을 때는 필요 없다
        */}
        {(packages.length === 0 || !packageId) && (!busy || adding === 'new') ? (
          /* 첫 화면 — 열린 파일이 없거나, 로고로 나왔을 때(보는 파일 없음).
             빈 세 칸만 띄워 두면 처음 쓰는 사람은 손댈 곳을 찾지 못한다 */
          <div className="welcome">
            <span className="wordmark big">VEXPLOR</span>
            <h1>AAS Studio</h1>
            <p>
              {packages.length > 0
                ? t('서버에 올려 둔 파일이 있습니다 — 아래에서 골라 이어서 작업하거나, 새 파일을 엽니다.')
                : t('AASX 파일을 열면 계층 트리·규칙 지적·수집이 한 화면에 뜹니다.')}
            </p>
            {/*
              🔴 이어서 작업하기 — 로고로 나왔거나 다시 들어온 사람이 처음 보는 자리다.
                 전에는 「AASX 파일 열기」만 커서 **같은 파일을 또 올려** 목록에 사본이 쌓였다(2026-09-09 검토).
                 올려 둔 것이 있으면 그 목록이 먼저다. 파란 버튼도 이쪽으로 넘긴다
            */}
            {packages.length > 0 && adding !== 'new' && (
              /*
                🔴 접어 둔다(2026-10-01 사용자 요청) — 파일이 16건 쌓이자 첫 화면을 목록이 덮었다.
                   `details`를 쓰는 이유: 펼침·접힘, 키보드(Enter·Space), 화면 낭독기 안내가
                   브라우저에 이미 들어 있다. 직접 만들면 그걸 전부 다시 해야 한다.
                   건수를 제목에 남겨 접혀 있어도 "여기 있다"가 보이게 한다.
              */
              <details className="welcome-files">
                <summary className="welcome-files-title">
                  {t('이어서 작업하기')} — {t('올려 둔 파일')} {packages.length}
                  {lang === 'ko' ? tr('건') : ''}
                </summary>
                <ul>
                  {packages.map((item) => (
                    <li key={item.packageId}>
                      <button
                        className="welcome-file"
                        disabled={busy}
                        onClick={() => void loadPackage(item.packageId)}
                        title={t('이 파일을 엽니다')}
                      >
                        <b>{item.name ?? item.packageId}</b>
                        {item.assetName && <span className="dim">{item.assetName}</span>}
                        {item.updatedAt && <span className="dim file-date">{item.updatedAt.slice(0, 10)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="hint">
                  {t('같은 파일을 다시 올리면 사본이 하나 더 생깁니다 — 하던 파일은 여기서 고르십시오.')}
                </p>
              </details>
            )}
            <div className="row-buttons">
              {/* 파란 배경은 "지금 하는 일"을 따라간다 — 새로 만들기를 누르면 그쪽이 파랗다.
                  올려 둔 파일이 있으면 위 목록이 주인공이라 둘 다 보통 버튼이다 */}
              <button
                className={adding === 'new' || packages.length > 0 ? 'big' : 'primary big'}
                onClick={() => {
                  setAdding(undefined);
                  fileInput.current?.click();
                }}
              >
                {t('AASX 파일 열기')}
              </button>
              <button
                className={adding === 'new' ? 'primary big' : 'big'}
                onClick={() => setAdding('new')}
              >
                {t('새로 만들기')}
              </button>
              {/*
                🔴 번들 열기 — 헤더와 같은 세 갈래를 첫 화면에도 둔다(2026-10-01 사용자 요청).
                   첫 화면에 둘뿐이라 "번들은 어디서 여나"를 헤더에서 찾아야 했다.
                   헤더의 것과 **같은 파일 고르개**(bundleInput)를 쓴다 — 두 개를 두면 갈라진다.
              */}
              <button className="big" disabled={busy} onClick={() => bundleInput.current?.click()}>
                {t('번들 열기')}
              </button>
            </div>
            {packages.length === 0 && adding !== 'new' && (
              <p className="welcome-sample">
                {tr('AASX 파일이 아직 없다면 — ')}
                <button
                  className="link"
                  disabled={busy}
                  title={tr('다 채워진 설비 1종과 공정 구성을 열어 둘러봅니다 — 고쳐도 되는 연습용입니다')}
                  onClick={() => void onOpenSample()}
                >
                  {tr('견본으로 시작하기')}
                </button>
              </p>
            )}
          {adding === 'new' && (
              <NewPackage
                t={t}
                {...(policy ? { policy } : {})}
                busy={busy}
                onCancel={() => setAdding(undefined)}
                candidates={packages}
                onImportFile={onImportForTree}
                onCreate={(name, extras, unit, tree) => void onCreatePackage(name, extras, unit, tree)}
              />
            )}
          </div>
        ) : (
        <>
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
        <Splitter
          label={tr('트리')}
          value={shownPanes.left}
          onMove={(delta) => movePane('left', delta)}
          onReset={() => setPanes((current) => ({ ...current, left: DEFAULT_PANES.left }))}
          onCommit={commitPanes}
        />
        <div className="middle">
          {filesOpen && (
            <div className="file-list">
              <div className="file-list-head">
                <h3><T k={'열린 파일 {0}건'} v={[packages.length]} /></h3>
                <button className="link" onClick={() => setFilesOpen(false)}>
                  {tr('닫기')}
                </button>
              </div>
              {/* 여러 개를 한 번에 — 시험 잔재를 하나씩 지우던 손이 지쳤다(사용자 2026-09-09) */}
              <label className="file-pick-all">
                <input
                  type="checkbox"
                  aria-label={tr('전체 고르기')}
                  checked={packages.length > 0 && packages.every((item) => pickedFiles.has(item.packageId))}
                  onChange={(event) =>
                    setPickedFiles(event.target.checked ? new Set(packages.map((item) => item.packageId)) : new Set())
                  }
                />
                <span className="dim">{tr('전체 고르기')}</span>
              </label>
              <ul>
                {packages.map((item) => (
                  <li key={item.packageId}>
                    <input
                      type="checkbox"
                      aria-label={fill(tr('{0} 고르기'), { 0: item.name ?? item.packageId })}
                      checked={pickedFiles.has(item.packageId)}
                      disabled={busy}
                      onChange={(event) =>
                        setPickedFiles((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(item.packageId);
                          else next.delete(item.packageId);
                          return next;
                        })
                      }
                    />
                    <button
                      className={`link file-name${item.packageId === packageId ? ' current' : ''}`}
                      disabled={busy}
                      onClick={() => void loadPackage(item.packageId)}
                      title={tr('이 파일 열기')}
                    >
                      {item.name ?? item.packageId}
                    </button>
                    {item.assetName && <span className="dim">{item.assetName}</span>}
                    {item.updatedAt && (
                      <span className="dim file-date">{item.updatedAt.slice(0, 10)}</span>
                    )}
                    <button
                      className="link danger"
                      disabled={busy}
                      title={tr('서버에서 이 파일을 지웁니다 — 되돌릴 수 없습니다. 내려받아 둔 .aasx는 남습니다')}
                      onClick={() => void onDeletePackage(item.packageId)}
                    >
                      {tr('지우기')}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="file-bulk">
                <button
                  className="danger"
                  disabled={busy || pickedFiles.size === 0}
                  onClick={() => void deletePackages([...pickedFiles])}
                  title={tr('체크한 파일을 한 번에 지웁니다')}
                ><T k={'고른 {0}건 지우기'} v={[pickedFiles.size]} /></button>
                <span className="hint">{tr('지우면 되돌릴 수 없습니다. 내려받아 둔 .aasx 파일은 남습니다.')}</span>
              </div>
            </div>
          )}
          {historyFor && (
            <div className="history-panel">
              <div className="file-list-head">
                <h3>
                  {historyFor.label} — {fill(t('변경 이력 {n}건'), { n: historyEntries.length })}
                </h3>
                <button className="link" onClick={() => setHistoryFor(undefined)}>
                  {t('닫기')}
                </button>
              </div>
              {historyEntries.length === 0 ? (
                <p className="hint">{t('아직 변경한 적이 없습니다 — 처음 만든 그대로입니다.')}</p>
              ) : (
                <ul>
                  {historyEntries.map((entry) => (
                    <li key={entry.changedAt}>
                      <span className="mono">{localTime(entry.changedAt)}</span>
                      <span className="dim">
                        {entry.operation === 'delete'
                          ? t('지워지기 전')
                          : fill(t('고치기 전 (요소 {n}개)'), { n: entry.elementCount })}
                      </span>
                      {/* 「누가」 — 로그인을 쓰지 않는 서버와 옛 기록에는 없다. 없으면 아예 안 보인다:
                          「기록 없음」이라고 적으면 빈 칸이 줄마다 늘어서 눈이 피로하다 */}
                      {entry.actorName && (
                        <span className="who" title={entry.actorName}>
                          {entry.actorName}
                        </span>
                      )}
                      <button
                        className="link"
                        disabled={busy}
                        title={t('이 시점의 내용으로 되돌립니다 — 그 뒤에 고친 것은 사라집니다')}
                        onClick={() => void onRestore(entry.changedAt)}
                      >
                        {t('이 판으로 되돌리기')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint">{t('되돌리기 자체도 이력에 남습니다 — 되돌린 것을 또 되돌릴 수 있습니다.')}</p>
            </div>
          )}
          {adding === 'aid' && packageId && (
            <AddAid
              packageId={packageId}
              leafNames={leafNames}
              busy={busy}
              {...(opcua?.running && opcua.endpoint ? { outEndpoint: opcua.endpoint } : {})}
              onCancel={() => setAdding(undefined)}
              onDone={(summary) => {
                setAdding(undefined);
                setNotice(summary);
                if (packageId) void loadPackage(packageId);
              }}
            />
          )}
          {adding === 'docs' && packageId && (
            <DocAssets
              packageId={packageId}
              submodels={submodels}
              assetName={shell?.idShort ?? tr('설비')}
              onClose={() => setAdding(undefined)}
            />
          )}
          {adding === 'bundle' && packageId && (
            <BundlePanel
              packageId={packageId}
              onOpenPackage={(id) => {
                setAdding(undefined);
                void loadPackage(id);
              }}
              onClose={() => setAdding(undefined)}
            />
          )}
          {adding === 'new' && (
            <NewPackage
              t={t}
              {...(policy ? { policy } : {})}
              busy={busy}
              onCancel={() => setAdding(undefined)}
              candidates={packages}
              onImportFile={onImportForTree}
              onCreate={(name, extras, unit, tree) => void onCreatePackage(name, extras, unit, tree)}
            />
          )}
          {adding === 'submodel' && (
            <AddSubmodel
              {...(policy ? { policy } : {})}
              assetName={submodelTarget?.assetName ?? shell?.idShort ?? 'Asset'}
              existing={submodels.map((sm) => sm.idShort ?? '')}
              busy={busy}
              onCancel={() => setAdding(undefined)}
              onCreate={(content) => void onCreateSubmodel(content)}
            />
          )}
          {adding === 'import' && packageId && (
            <ImportSubmodel
              packages={packages}
              currentPackageId={packageId}
              existing={submodels}
              busy={busy}
              onCancel={() => setAdding(undefined)}
              onImport={(source, submodelId, onDuplicate) => void onImport(source, submodelId, onDuplicate)}
            />
          )}
          {adding && adding !== 'submodel' && adding !== 'import' && adding !== 'new' && adding !== 'docs' && adding !== 'aid' && adding !== 'bundle' && (
            <AddElement
              parentLabel={adding.label}
              busy={busy}
              onCancel={() => setAdding(undefined)}
              onCreate={(content) => void onCreateElement(adding, content)}
            />
          )}
          {!selected && !adding && packageId && (
            <Summary
              t={t}
              fileName={packages.find((item) => item.packageId === packageId)?.name ?? packageId}
              unit={fileUnit}
              onAddSubmodel={() => setAdding('submodel')}
              onAddAsset={() => setHierAdder({ path: [], kind: 'asset' })}
              onAddGroup={() => setHierAdder({ path: [], kind: 'group' })}
              ledgerCount={Object.keys(ledger).length}
              onRevertLedger={() => void onRevertLedger()}
              thumbnailPlaceholder={
                (shells[0]?.assetInformation?.['defaultThumbnail'] as { path?: string } | undefined)
                  ?.path === '/thumbnail.png'
              }
              {...(String(shells[0]?.assetInformation?.['assetType'] ?? '').includes('/type/') &&
              hierarchy?.entryNode
                ? {
                    totals: (() => {
                      let subCount = submodels.length;
                      let elementCount = countElements(submodels);
                      let conceptCount = concepts.length;
                      let unopened = 0;
                      const walk = (nodes: LinkedInfo[]): void => {
                        for (const node of nodes) {
                          if (node.submodels) {
                            subCount += node.submodels.length;
                            elementCount += countElements(node.submodels);
                            conceptCount += node.concepts?.length ?? 0;
                            // 🔴 열린 설비 밑의 부품(BoM)은 그 설비 파일 안에 이미 셈해졌다 — 파일이 따로 있는 것이
                            //    아니다. 예전엔 롤포밍기의 부품 3개를 「안 열린 설비 3건」으로 셌다(2026-09-30 검증).
                            //    다만 열린 파일이 묶음(공정)이면 그 밑은 다른 파일이라 계속 센다
                            if (!node.composite) continue;
                          } else if (node.children.length === 0 && !node.group) {
                            unopened += 1; // 파일이 안 열려 내용을 모른다 — 숨기지 말고 알린다
                          }
                          walk(node.children);
                        }
                      };
                      walk(linked);
                      return { submodels: subCount, elements: elementCount, concepts: conceptCount, unopened };
                    })(),
                    composition: (() => {
                      // 사람이 보는 구성으로 센다 — 그룹(공정·층)과 설비(참조), 대수 합
                      let groups = 0;
                      let assets = 0;
                      let units = 0;
                      const walk = (nodes: HierarchyNode[]): void => {
                        for (const node of nodes) {
                          if (node.globalAssetId === '') groups += 1;
                          else {
                            assets += 1;
                            units += node.bulkCount;
                          }
                          walk(node.children);
                        }
                      };
                      walk(hierarchy.children);
                      return { groups, assets, units };
                    })(),
                  }
                : {})}
              shells={shells}
              submodels={submodels}
              concepts={concepts}
              findings={allFindings}
              {...(policy &&
              // 🔴 조직 단위(공정·회사 — assetType=…/type/*)에는 설비 필수 4종 안내를 하지
              //    않는다 — 계층만으로 시작하는 것이 맞다(2026-08-26 확정)
              !String(shells[0]?.assetInformation?.['assetType'] ?? '').includes('/type/')
                ? { requiredSubmodels: policy.requiredSubmodels }
                : {})}
            >
              {fileUnit === 'composite' ? hierarchyPanel : undefined}
            </Summary>
          )}
          {!selected && !adding && packageId && fileUnit === 'equipment' && hierarchyPanel}
          {/* ⚙ 설비 컨텍스트 — 고른 장비에 맞는 동작이 그 자리에 나온다(초보자 원칙) */}
          {selected && selected.modelType === 'LinkedAsset' && selected.linkedPackageId && (
            <div className="asset-context">
              <button className="link inspector-close" onClick={() => setSelectedKey(undefined)}>
                {tr('닫기 ✕')}
              </button>
              <h2>⚙ {selected.label}</h2>
              <p className="hint"><T k={'파일: {0}'} v={[<span className="mono">
                  {packages.find((item) => item.packageId === selected.linkedPackageId)?.name ??
                    selected.linkedPackageId}
                </span>]} />
              </p>
              <div className="row-buttons asset-actions">
                <button
                  className="primary"
                  disabled={busy}
                  title={tr('이 설비 파일에 서브모델을 만듭니다 — 지금 보는 공정 파일이 아니라 그 설비 파일에 저장됩니다')}
                  onClick={() => {
                    // 이 설비 파일에 만들어진다 — onCreateSubmodel이 대상을 보고 라우팅한다
                    setSubmodelTarget({
                      pid: selected.linkedPackageId!,
                      assetName: selected.node.idShort ?? selected.label,
                    });
                    setAdding('submodel');
                    setSelectedKey(undefined);
                  }}
                >
                  {tr('이 설비에 서브모델 추가')}
                </button>
                <button
                  disabled={busy}
                  title={tr('이 설비 파일을 엽니다 — 지금 보는 공정 파일 대신 그 파일로 바뀝니다')}
                  onClick={() => void loadPackage(selected.linkedPackageId!)}
                >
                  {tr('이 설비 파일 열기 →')}
                </button>
              </div>
              <p className="hint">
                {tr('밑에 펼쳐진 서브모델·요소는 여기서 바로 고칠 수 있습니다 — 저장하면 이 설비 파일이 바뀝니다.')}
              </p>
            </div>
          )}
          {selected && selected.modelType !== 'LinkedAsset' && (
          <Inspector
            t={t}
            {...(selected ? { node: selected, trail: selectedTrail } : {})}
            {...(selected?.linkedPackageId !== undefined
              ? {
                  linkedFileName:
                    packages.find((item) => item.packageId === selected.linkedPackageId)?.name ??
                    selected.linkedPackageId,
                }
              : {})}
            onClose={() => setSelectedKey(undefined)}
            onChangeValueType={(node, valueType) => void onChangeValueType(node, valueType)}
            onShowHistory={(node) => void onShowHistory(node)}
            onBulkSaveValues={(node, content) => void onBulkSaveValues(node, content)}
            busy={busy}
            onSave={(node, value) => void onSave(node, value)}
            {...(selected && CONTAINER_TYPES.has(selected.modelType)
              ? { onAddChild: (node: TreeNode) => setAdding(node) }
              : {})}
            {...(selected && (selected.modelType === 'Submodel' || selected.idShortPath !== undefined)
              ? { onDelete: (node: TreeNode) => void onDelete(node) }
              : {})}
            {...(selected &&
            selected.idShortPath !== undefined &&
            selected.linkedPackageId === undefined &&
            CONTAINER_TYPES.has(selected.modelType)
              ? { onDuplicate: (node: TreeNode) => void onDuplicate(node) }
              : {})}
            {...(policy ? { policy } : {})}
            conceptIds={
              selected?.linkedPackageId !== undefined
                ? (linkedConceptIds.get(selected.linkedPackageId) ?? conceptIds)
                : conceptIds
            }
            onSaveSemanticId={(node, value) => void onSaveSemanticId(node, value)}
            onSaveAssetInformation={(info) => void onSaveAssetInformation(info)}
            onSaveConcept={(concept) => void onSaveConcept(concept)}
            onUploadThumbnail={(file) => void onUploadThumbnail(file)}
            onRename={(node, value) => void onRename(node, value)}
            onUploadAttachment={(node, file) => void onUploadAttachment(node, file)}
            onDownloadAttachment={(node, name) => void onDownloadAttachment(node, name)}
            onDeleteAttachment={(node) => void onDeleteAttachment(node)}
          />
          )}
        </div>
        <Splitter
          label={tr('오른쪽 칸')}
          value={shownPanes.right}
          onMove={(delta) => movePane('middle', delta)}
          onReset={() => setPanes((current) => ({ ...current, right: DEFAULT_PANES.right }))}
          onCommit={commitPanes}
        />
        {/*
          오른쪽 칸 — 수집(OPC UA)이 상시 자리한다.
          🔴 파일을 고르든 요소를 고르든 **연결 상태는 늘 보여야 한다**. 값이 들어오는지,
             밖으로 내주고 있는지는 편집 중에도 알아야 하는 정보다.
        */}
        <div className="right-pane">
          {/* 새 파일을 만드는 동안은 이전 파일의 수집 안내를 걷는다 — "이 파일"이 무엇인지 헷갈렸다(2026-09-07) */}
          {adding === 'new' && (
            <div className="collection empty">
              <h3>{tr('← 수집 — 설비에서 받아 오기')}</h3>
              <p className="hint">
                {tr('새 파일을 만들고 있습니다. 수집 연결은 파일이 만들어진 뒤 이 자리에서 잇습니다.')}
              </p>
            </div>
          )}
          {packageId && adding !== 'new' && (
            <Collection
              t={t}
              interfaces={interfaces}
              values={values}
              {...(live ? { live } : {})}
              {...(autoCollect?.running ? { auto: autoCollect } : {})}
              busy={busy}
              {...(lastCycle ? { cycle: lastCycle } : {})}
              {...(packageId ? { packageId } : {})}
              onCollect={() => void onCollect()}
              onCreateAid={() => setAdding('aid')}
              onDeleteAid={() => void onDeleteAid()}
              unit={fileUnit}
              {...(autoCollect?.collect ? { onSimulate: () => void onSimulate() } : {})}
              {...(fileUnit === 'composite'
                ? {
                    equipment: equipmentRows,
                    onOpenEquipment: (pid: string) => void loadPackage(pid),
                    onConnectEquipment: (pid: string) => void onConnectEquipment(pid),
                    ...(autoCollect?.collect
                      ? {
                          onSimulateEquipment: (pid: string) => void onSimulateEquipment(pid),
                          onCollectEquipment: (pid: string) => void onCollectEquipment(pid),
                        }
                      : {}),
                  }
                : {})}
            />
          )}
        </div>
        </>
        )}
      </main>

      {/*
        내주기 팝업 — 이 주소가 **어떤 종류의 주소인지** 여기서 못박는다.
        🔴 사고의 원인이 「주소가 두 개인데 둘 다 그냥 '주소'로 보인 것」이었다.
      */}
      {showOpcua && opcua?.running && (
        <div className="modal-back" role="presentation" onClick={() => setShowOpcua(false)}>
          <div
            className="modal opcua-out"
            role="dialog"
            aria-modal="true"
            aria-label={tr('내주는 중')}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="link modal-close"
              aria-label={tr('내주기 창 닫기')}
              onClick={() => setShowOpcua(false)}
            >
              {tr('닫기 ✕')}
            </button>
            <h3>{tr('→ 다른 시스템에 값 내주는 중')}</h3>
            <p className="flow"><T k={'[설비·PLC] ──▶ <b>[이 도구]</b> ──▶ [MES·SCADA]'} /></p>
            <p className="hint"><T k={'작성한 AAS를 OPC UA 서버로 내주고 있습니다. 상위 앱이 <b>구독</b>으로 값을 받아 갑니다 — 값이 바뀌면 이쪽에서 먼저 알립니다.'} /></p>
            <dl>
              <dt>{tr('상위 앱에 알려 줄 주소')}</dt>
              <dd className="mono">{opcua.endpoint}</dd>
              <dt>{tr('내주는 파일')}</dt>
              <dd>
                <T k={'{0}개 · 변수 {1}개'} v={[opcua.packages, opcua.variables]} /></dd>
            </dl>
            <p className="note warn"><T k={'주의 — 이 주소는 <b>남이 접속해 올 주소</b>입니다. 수집 연결의 「설비 주소」 칸에 넣는 주소가 아닙니다 — 거기 넣으면 우리가 내준 값을 우리가 다시 읽게 됩니다.'} /></p>
            <p className="hint">{tr('전부 읽기 전용입니다. 밖에서 값을 바꿀 수 없습니다.')}</p>
          </div>
        </div>
      )}

      {/*
        지적 목록 — 볼 때만 뜬다. 헤더의 「위반 N건」을 누르면 열린다.
        🔴 지적을 누르면 그 요소로 가야 하므로 **닫고 나서** 이동한다 —
           팝업이 덮고 있으면 어디로 갔는지 볼 수 없다.
      */}
      {/* 자동 고치기 미리보기 — 파일별로 묶어 항목별 전/후, 체크한 것만 반영 */}
      {fixPlans && (
        <div className="modal-back" role="presentation" onClick={() => setFixPlans(undefined)}>
          <div
            className="modal fix-modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr('자동 고치기 미리보기')}
            onClick={(event) => event.stopPropagation()}
          >
            <FixPreview
              plans={fixPlans}
              busy={busy}
              onApply={(select) => void onApplyFix(select)}
              onCancel={() => setFixPlans(undefined)}
            />
          </div>
        </div>
      )}

      {showAccounts && auth?.user && (
        <div className="modal-back" role="presentation" onClick={() => setShowAccounts(false)}>
          <div
            className="modal accounts-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('계정')}
            onClick={(event) => event.stopPropagation()}
          >
            <Accounts
              me={auth.user}
              t={t}
              describeError={describeError}
              onChanged={() => void bootstrap()}
              onClose={() => setShowAccounts(false)}
            />
          </div>
        </div>
      )}

      {/* 설정 — 지금은 언어 하나. 고르면 바로 적용되고 이 브라우저에 남는다 */}
      {showSettings && (
        <div className="modal-back" role="presentation" onClick={() => setShowSettings(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr('설정')}
            onClick={(event) => event.stopPropagation()}
          >
            <Settings
              lang={lang}
              t={t}
              onChange={(next) => {
                if (next === lang) return;
                writeLang(next);
                // 🔴 새로 읽는다 — 파일 맨 위의 글자표는 처음 읽힌 언어로 굳어 있다(i18n.ts `current`).
                //    상태만 바꿔 다시 그리면 반은 영어, 반은 한국어가 된다
                window.location.reload();
              }}
              onClose={() => setShowSettings(false)}
            />
          </div>
        </div>
      )}

      {showFindings && (
        <div
          className="modal-back"
          role="presentation"
          onClick={() => setShowFindings(false)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr('지적 목록')}
            onClick={(event) => event.stopPropagation()}
          >
            {/* 속성 칸에도 「닫기 ✕」가 있다 — 무엇을 닫는지 읽어 주는 이름을 따로 준다 */}
            <button
              className="link modal-close"
              aria-label={tr('지적 목록 닫기')}
              onClick={() => setShowFindings(false)}
            >
              {tr('닫기 ✕')}
            </button>
            <FindingsPanel
              findings={allFindings}
              {...(fixReport ? { skipped: fixReport.skipped } : {})}
              {...(selected ? { activePointer: selected.pointer } : {})}
              onSelect={(finding) => {
                setShowFindings(false);
                onSelectFinding(finding);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
