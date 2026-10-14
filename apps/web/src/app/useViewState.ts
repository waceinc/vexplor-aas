/**
 * 화면 상태 — 고른 요소 · 펼침 · 찾기 · 열린 양식과 창.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 선언과 주석은 옮기기 전 글자 그대로다.
 */
import { useRef, useState } from 'react';
import { type HistoryEntry } from '../api.js';
import { type Adder } from '../components/HierarchyTree.js';
import { type FixPlan } from '../components/FixPreview.js';
import { type Adding } from './types.js';

export function useViewState() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /**
   * 선택은 **노드 객체가 아니라 위치**로 들고 있는다.
   * 저장할 때마다 서버에서 다시 읽어 트리를 새로 만들기 때문에, 객체를 쥐고 있으면
   * 화면에 낡은 값이 남는다.
   */
  const [selectedKey, setSelectedKey] = useState<string>();
  /** 트리에서 찾기 */
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState<string>();
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
  /** 열려 있는 추가 폼 — 'submodel'이거나 부모 노드 */
  const [adding, setAdding] = useState<Adding>();
  /** 규칙·규약 화면 — 판정 근거를 보여 준다 */
  const [showRules, setShowRules] = useState(false);
  /**
   * 지적 목록을 팝업으로 볼지.
   * 🔴 오른쪽 칸을 상시 차지하던 것을 걷어냈다 — 대부분의 시간에는 「몇 건인가」만 알면 되고,
   *    목록은 볼 때만 보면 된다. 그 자리는 수집(OPC UA)이 쓴다(2026-09-01 사용자 요청).
   */
  const [showFindings, setShowFindings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** 계정 화면 — 내 비밀번호, 그리고 관리자면 사람 더하기·역할·잠그기 */
  /** 계정 창 — mine: 내 계정 설정(누구나) · people: 계정 관리(관리자) */
  const [showAccounts, setShowAccounts] = useState<'mine' | 'people'>();
  /**
   * 자동 고치기 미리보기 — 열려 있으면 팝업. 체크한 것만 반영한다(사용자 2026-09-11).
   * 🔴 **파일마다 한 묶음**이다. 공정(묶음)을 열면 이어 붙인 설비 파일들도 함께 들어온다
   *    (2026-10-01). 고치기는 각자의 원본 파일로 간다 — 편집·서브모델 추가와 같은 길이다.
   */
  const [fixPlans, setFixPlans] = useState<FixPlan[] | undefined>();
  /** 「내주는 중」 칩을 눌렀을 때 — 주소가 무엇을 뜻하는지 여기서만 말한다 */
  const [showOpcua, setShowOpcua] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  return { expanded, setExpanded, selectedKey, setSelectedKey, query, setQuery, reveal, setReveal, filesOpen, setFilesOpen, pickedFiles, setPickedFiles, submodelTarget, setSubmodelTarget, hierAdder, setHierAdder, historyFor, setHistoryFor, historyEntries, setHistoryEntries, adding, setAdding, showRules, setShowRules, showFindings, setShowFindings, showSettings, setShowSettings, showAccounts, setShowAccounts, fixPlans, setFixPlans, showOpcua, setShowOpcua, fileInput, bundleInput };
}
