/**
 * 지금 연 파일의 내용 — 서버에서 읽어 온 데이터(서브모델 · 지적 · 계층 · 수집값 · 판 번호 · 되돌리기 스택 · 연결 파일).
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 선언과 주석은 옮기기 전 글자 그대로다.
 */
import { useMemo, useRef, useState } from 'react';
import { api, type AidInterfaceView, type HierarchyView, type UndoStatus, type CycleReportView, type LiveMapping, type CollectedValueView, type FixReport, type PackageDescription, type Policy, type SubmodelRequirement } from '../api.js';
import { type LinkedInfo, type Finding, type ConceptDescription, type Shell, type Submodel } from '../model.js';

export function useDocumentState() {
  const [packages, setPackages] = useState<PackageDescription[]>([]);
  const [packageId, setPackageId] = useState<string>();
  const [submodels, setSubmodels] = useState<Submodel[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
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
  /** IRI 이관 대장(새 → 원본) — 파일 안 파트. 비어 있으면 요약에 아무것도 안 뜬다 */
  const [ledger, setLedger] = useState<Record<string, string>>({});
  /** 템플릿 요구 수준 — 서브모델 id → 요소마다 필수 · 선택. 템플릿이 없는 서브모델은 없다(모름) */
  const [requirements, setRequirements] = useState<Record<string, SubmodelRequirement>>({});
  /**
   * 미리보기가 "못 고친다"고 한 지적 수 — 단추 숫자와 팝업이 어긋나지 않게 하는 근거.
   * 🔴 규칙의 fixable 표시만 믿으면 단추는 「2건」인데 들어가면 "사람이 판단"이 된다(사용자 2026-09-11).
   *    파일을 열 때 저장 없는 미리보기를 한 번 돌려, 실제로 못 고치는 지적은 fixable을 끈다
   */
  const [unfixable, setUnfixable] = useState(0);
  /** 미리보기가 실제로 고치겠다고 한 건수 — 단추의 숫자. 한 지적을 고치면 다음 바퀴에 드러나는 것까지 센다(팝업 줄 수와 같다) */
  const [fixCount, setFixCount] = useState<number | undefined>();
  /** 마지막으로 연 파일. 같은 파일을 다시 읽을 때 펼침 상태를 지키는 데 쓴다 */
  const openedRef = useRef<string>(undefined);
  return { packages, setPackages, packageId, setPackageId, submodels, setSubmodels, findings, setFindings, fixReport, setFixReport, policy, setPolicy, shells, setShells, concepts, setConcepts, shell, conceptIds, interfaces, setInterfaces, hierarchy, setHierarchy, linked, setLinked, linkedConceptIds, linkedRevisions, setLinkedRevisions, linkedFindings, setLinkedFindings, values, setValues, live, setLive, autoCollect, setAutoCollect, opcua, setOpcua, version, setVersion, lastCycle, setLastCycle, revisions, setRevisions, undoState, setUndoState, shellRevisions, setShellRevisions, ledger, setLedger, requirements, setRequirements, unfixable, setUnfixable, fixCount, setFixCount, openedRef };
}
