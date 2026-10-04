/**
 * 트리 구성과 위치 계산 — 화면이 없어도 성립하는 순수 로직.
 *
 * 여기서 가장 중요한 것은 **린터가 가리키는 위치와 UI가 여는 노드가 같아야 한다**는 점이다.
 * 지적을 눌렀는데 그 요소가 열리지 않으면 린터의 값어치가 반으로 준다(docs/PROGRESS.md §5).
 * 그래서 노드마다 두 가지 주소를 함께 만든다.
 *   pointer     — Environment JSON Pointer. 린터 finding.pointer와 맞댄다
 *   idShortPath — IDTA Part 2 경로. API로 값을 고칠 때 쓴다
 */
import { fill, tr } from './i18n.js';


export interface Finding {
  ruleId: string;
  layer: string;
  severity: 'error' | 'warning' | 'info';
  elementType: string;
  key: string;
  pointer: string;
  kosmoPath: string;
  message: string;
  remedy?: string;
  fixable: boolean;
  policyNote?: string;
}

export interface AasNode {
  modelType: string;
  idShort?: string;
  value?: unknown;
  statements?: AasNode[];
  annotations?: AasNode[];
  valueType?: string;
  [key: string]: unknown;
}

export interface Submodel extends AasNode {
  id: string;
  submodelElements?: AasNode[];
}

export interface Shell extends AasNode {
  id: string;
  assetInformation?: Record<string, unknown>;
}

export interface ConceptDescription extends AasNode {
  id: string;
}

export interface Environment {
  shells: readonly Shell[];
  submodels: readonly Submodel[];
  conceptDescriptions: readonly ConceptDescription[];
}

/**
 * ISO 시각 → 이 PC 시간대의 `YYYY-MM-DD HH:mm:ss`.
 * 🔴 수집 표·주소 목록 CSV·이력이 UTC를 그대로 찍고 있었다(서울 10:35에 「01:35」 — 2026-09-10 실측).
 *    검증 결과서는 2026-09-04에 현지 시각으로 고쳤는데 화면 쪽이 남아 있었다
 */
export function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface TreeNode {
  /** React key이자 펼침 상태의 식별자 */
  key: string;
  label: string;
  modelType: string;
  /** Environment JSON Pointer — 린터 finding과 맞댄다 */
  pointer: string;
  /** Part 2 idShortPath. Submodel 자신은 undefined */
  idShortPath?: string;
  submodelId: string;
  depth: number;
  children: TreeNode[];
  node: AasNode;
  /**
   * 다른 파일에서 읽어 온 **보기 전용** 가지인가(공정 트리의 설비).
   * 파일 구조는 참조형 그대로다 — 화면에서만 이어 붙인 것이라 편집 대상이 아니다.
   */
  linkedPackageId?: string;
  /** ⚙ 가지 중 공정·라인(파일 없는 층) — ▦로 그린다 */
  linkedGroup?: boolean;
  /** 설비의 부품(BoM) — 파일도 동작도 없다. 설비(⚙)와 헷갈리지 않게 흐리게, 종류는 Part */
  linkedPart?: boolean;
  /** 설비 밑 부품을 접어 두는 「BOM (n)」 줄 */
  linkedPartGroup?: boolean;
  /**
   * 종류(영문 규격명) 옆에 붙는 우리말 한 줄 — 초보자가 "이건 뭔가"를 묻던 자리에만 단다.
   * 지금은 HierarchicalStructures 서브모델뿐: 회사 파일에서는 「회사·공정 구성도」, 설비 파일에서는 「부품 구성 (BOM)」
   * (사용자 2026-09-09 "괄호 안 문구를 바꿔서 초보자도 구분할 수 있게"). 종류명 자체는 규격 원문 그대로 둔다
   */
  typeNote?: string;
  /** typeNote에 마우스를 올리면 나오는 긴 설명 */
  typeTitle?: string;
}

/** 자식을 담는 필드 — @aas/core의 traverse와 같은 규칙이어야 한다 */
function childrenOf(node: AasNode): { field: string; items: AasNode[] } | undefined {
  if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
    return Array.isArray(node.value) ? { field: 'value', items: node.value as AasNode[] } : undefined;
  }
  if (node.modelType === 'Entity') {
    return node.statements ? { field: 'statements', items: node.statements } : undefined;
  }
  if (node.modelType === 'AnnotatedRelationshipElement') {
    return node.annotations ? { field: 'annotations', items: node.annotations } : undefined;
  }
  return undefined;
}

/**
 * Environment 전체를 트리로 만든다 — AAS · Submodel · ConceptDescription 셋 다.
 *
 * 서브모델만 그리던 때는 **지적의 갈 곳이 없었다.** 실측 결함 중 `KOSMO-AAS-*`는 AAS에,
 * `KOSMO-CD-*`는 ConceptDescription에 붙는데, 트리에 그 노드가 없으니 눌러도 열리지 않았다
 * (화면으로 보고서야 드러났다 — 「위반 4건」인데 트리 배지는 2개뿐이었다).
 *
 * ConceptDescription은 137개까지 가므로 **그룹 노드 아래에 접어 둔다.** 트리를 오염시키지 않으면서
 * 지적이 갈 자리는 만들어 준다.
 *
 * 목록 순서가 곧 Environment 배열 순서다(저장소가 ordinal로 지킨다) — 그래야 pointer가 린터와 맞는다.
 */
export const CONCEPT_GROUP_KEY = '/conceptDescriptions';

export function buildTree(environment: Environment): TreeNode[] {
  const roots: TreeNode[] = [];

  environment.shells.forEach((shell, index) => {
    const pointer = `/assetAdministrationShells/${index}`;
    const node: TreeNode = {
      key: pointer,
      label: shell.idShort ?? shell.id,
      modelType: 'AssetAdministrationShell',
      pointer,
      submodelId: '',
      depth: 0,
      children: [],
      node: shell,
    };
    if (shell.assetInformation) {
      node.children.push({
        key: `${pointer}/assetInformation`,
        label: 'AssetInformation',
        modelType: 'AssetInformation',
        pointer: `${pointer}/assetInformation`,
        submodelId: '',
        depth: 1,
        children: [],
        node: shell.assetInformation as AasNode,
      });
    }
    roots.push(node);
  });

  environment.submodels.forEach((submodel, index) => {
    const pointer = `/submodels/${index}`;
    const root: TreeNode = {
      key: pointer,
      label: submodel.idShort ?? submodel.id,
      modelType: 'Submodel',
      pointer,
      submodelId: submodel.id,
      depth: 0,
      children: [],
      node: submodel,
    };
    root.children = buildElements(
      submodel.submodelElements ?? [],
      `${pointer}/submodelElements`,
      undefined,
      submodel.id,
      1,
      undefined,
    );
    roots.push(root);
  });

  if (environment.conceptDescriptions.length > 0) {
    roots.push({
      key: CONCEPT_GROUP_KEY,
      // 🔴 규격 용어를 그대로 쓴다(2026-09-01 사용자). 한글로 바꾸면 규격 문서·Validator
      //    리포트와 이름이 어긋나 대조가 안 된다. 무엇인지는 종류 표시와 속성 칸이 말한다.
      label: `ConceptDescriptions (${environment.conceptDescriptions.length})`,
      modelType: 'ConceptDescriptionGroup',
      pointer: CONCEPT_GROUP_KEY,
      submodelId: '',
      depth: 0,
      children: environment.conceptDescriptions.map((cd, index) => ({
        key: `${CONCEPT_GROUP_KEY}/${index}`,
        label: cd.idShort ?? cd.id,
        modelType: 'ConceptDescription',
        pointer: `${CONCEPT_GROUP_KEY}/${index}`,
        submodelId: '',
        depth: 1,
        children: [],
        node: cd,
      })),
      node: { modelType: 'ConceptDescriptionGroup' },
    });
  }

  return roots;
}

function buildElements(
  items: readonly AasNode[],
  pointerBase: string,
  parent: AasNode | undefined,
  submodelId: string,
  depth: number,
  parentPath: string | undefined,
): TreeNode[] {
  return items.map((node, index) => {
    const pointer = `${pointerBase}/${index}`;
    // SubmodelElementList의 자식은 규격상 인덱스로 가리킨다(익명일 수 있다)
    const inList = parent?.modelType === 'SubmodelElementList';
    const segment = inList ? `[${index}]` : (node.idShort ?? `[${index}]`);
    const idShortPath = inList
      ? `${parentPath ?? ''}${segment}`
      : parentPath
        ? `${parentPath}.${segment}`
        : segment;

    const tree: TreeNode = {
      key: pointer,
      label: node.idShort ?? `[${index}]`,
      modelType: node.modelType,
      pointer,
      idShortPath,
      submodelId,
      depth,
      children: [],
      node,
    };

    const children = childrenOf(node);
    if (children) {
      tree.children = buildElements(
        children.items,
        `${pointer}/${children.field}`,
        node,
        submodelId,
        depth + 1,
        idShortPath,
      );
    }
    return tree;
  });
}

/** 펼쳐진 것만 위에서부터 늘어놓는다. 가상 스크롤이 이 배열을 창으로 잘라 쓴다 */
export function flatten(roots: readonly TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0 && expanded.has(node.key)) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * 트리에서 찾기.
 *
 * 한 파일에 요소가 200개를 넘는다. 눈으로 훑는 것은 무리라 **걸러서 보여 준다** —
 * 찾은 노드와 **거기까지 가는 길(조상)** 만 남긴다. 조상을 함께 남기는 이유는
 * 같은 이름이 여러 서브모델에 있을 때 어느 것인지 알아야 하기 때문이다.
 *
 * 무엇을 뒤지나: 이름(idShort) · 종류 · 값 · semanticId. 대소문자는 가리지 않는다.
 */
export function searchTree(
  roots: readonly TreeNode[],
  query: string,
): { rows: TreeNode[]; matched: Set<string> } {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { rows: [], matched: new Set() };

  const matched = new Set<string>();
  const keep = new Set<string>();

  const hits = (node: TreeNode): boolean => {
    if (node.label.toLowerCase().includes(needle)) return true;
    if (node.modelType.toLowerCase().includes(needle)) return true;
    if (displayValue(node.node).toLowerCase().includes(needle)) return true;
    const semantic = node.node['semanticId'] as { keys?: { value: string }[] } | undefined;
    const id = semantic?.keys?.[0]?.value;
    if (id && id.toLowerCase().includes(needle)) return true;
    // 서브모델·CD는 id로도 찾을 수 있어야 한다 — 지적이 id로 말하기 때문이다
    const own = node.node['id'];
    return typeof own === 'string' && own.toLowerCase().includes(needle);
  };

  /** 아래에 걸린 게 있으면 나도 남는다(길을 끊지 않는다) */
  const walk = (node: TreeNode): boolean => {
    const self = hits(node);
    if (self) matched.add(node.key);
    let below = false;
    for (const child of node.children) below = walk(child) || below;
    if (self || below) keep.add(node.key);
    return self || below;
  };
  for (const root of roots) walk(root);

  const rows: TreeNode[] = [];
  const collect = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (!keep.has(node.key)) continue;
      rows.push(node);
      // 걸린 노드의 자식까지 펼쳐 보여 주지는 않는다 — 결과가 다시 길어진다
      if (!matched.has(node.key)) collect(node.children);
    }
  };
  collect(roots);

  return { rows, matched };
}

/**
 * 지적을 노드에 귀속시킨다.
 * finding.pointer는 노드보다 깊을 수 있다(`.../semanticId`, `.../value`) —
 * 그래서 **가장 길게 겹치는 노드**에 붙인다.
 */
export function attachFindings(
  roots: readonly TreeNode[],
  findings: readonly Finding[],
): Map<string, Finding[]> {
  const keys: string[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      keys.push(node.pointer);
      walk(node.children);
    }
  };
  walk(roots);
  keys.sort((a, b) => b.length - a.length); // 긴 것부터 본다

  const byNode = new Map<string, Finding[]>();
  for (const finding of findings) {
    const owner = keys.find((key) => finding.pointer === key || finding.pointer.startsWith(`${key}/`));
    if (owner === undefined) continue;
    byNode.set(owner, [...(byNode.get(owner) ?? []), finding]);
  }
  return byNode;
}

/**
 * 지적이 가리키는 노드와, 거기까지 가는 길에 있는 부모들.
 *
 * 문자열 규칙(숫자 세그먼트면 노드다)으로 짐작하지 않고 **실제 트리에서 찾는다** —
 * AAS의 `assetInformation`이나 ConceptDescription 그룹처럼 숫자로 끝나지 않는 노드가 있어서,
 * 규칙으로 맞히려 들면 그런 지적은 영영 열리지 않는다.
 */
export interface RevealPath {
  /** 펼쳐야 하는 노드들(대상 자신 포함) */
  keys: string[];
  /** 선택할 노드. 트리에 없으면 undefined */
  target?: string;
}

export function revealPath(roots: readonly TreeNode[], pointer: string): RevealPath {
  const chain: TreeNode[] = [];

  const walk = (nodes: readonly TreeNode[], parents: TreeNode[]): boolean => {
    for (const node of nodes) {
      const covers = pointer === node.pointer || pointer.startsWith(`${node.pointer}/`);
      if (!covers) continue;
      const here = [...parents, node];
      // 더 깊은 노드가 있으면 그쪽이 주인이다 (가장 길게 겹치는 노드)
      if (!walk(node.children, here)) chain.push(...here);
      return true;
    }
    return false;
  };

  walk(roots, []);
  const keys = chain.map((node) => node.pointer);
  const target = keys[keys.length - 1];
  return target === undefined ? { keys } : { keys, target };
}

/** 편집 가능한 값인지 — $value로 고칠 수 있는 종류만 화면에서 입력을 연다 */
export const EDITABLE_VALUE_TYPES = new Set(['Property', 'File', 'Blob', 'MultiLanguageProperty', 'Range']);


export function displayValue(node: AasNode): string {
  if (node.modelType === 'MultiLanguageProperty') {
    const list = (node.value as { language: string; text: string }[] | undefined) ?? [];
    return list.map((s) => `${s.language}: ${s.text}`).join(' / ');
  }
  if (node.modelType === 'Range') {
    return `${String(node['min'] ?? '')} ~ ${String(node['max'] ?? '')}`;
  }
  if (typeof node.value === 'string') return node.value;
  return '';
}

/**
 * semanticId 형식 검사 — M4 축소판(§2에서 eCl@ss 검색 UI 대신 직접 입력 + 검증으로 결정).
 *
 * 판정 근거는 실측 규칙이다.
 *  - KOSMO는 semanticId로 **IRDI(0173-/0112/) 또는 자체 IRI**만 인정한다(02_Validator_대응규칙 §110)
 *  - eCl@ss 말미 `-00` 코드는 CDP에 존재하지 않는다(AAS_OPC UA.md L9) — 재검증 대상
 *  - 형식이 맞아도 대응 CD가 없으면 KOSMO-SME-3으로 걸린다
 *
 * 린터가 어차피 잡아 주지만, **입력하는 순간 알려 주는 편이 되돌리기 싸다.**
 */
export interface SemanticIdNote {
  level: 'ok' | 'warning' | 'error';
  message: string;
}

/** eCl@ss IRDI — 예: 0173-1#02-AAA123#001 */
const ECLASS_IRDI = String.raw`0173-\d+#\d{2}-[A-Z0-9]+#\d{3}`;
/** IEC CDD IRDI — 예: 0112/2///61987#ABA231#009 */
const IEC_CDD_IRDI = String.raw`0112\/\d+\/\/\/[0-9_A-Za-z]+#[A-Z]{3}\d+#\d{3}`;
const ONE_IRDI = `(?:${ECLASS_IRDI}|${IEC_CDD_IRDI})`;
/**
 * 표준 사전 IRDI — **둘을 `/`로 이은 복합형도 표준이다**(사용자 2026-09-14 제기, 실측으로 확인).
 *
 * IDTA 템플릿이 리스트 항목(SMC)에 「속성 IRDI / 클래스 IRDI」를 이어 붙인다 —
 * 예: `0173-1#02-ABI500#003/0173-1#01-AHF579#003`(HandoverDocumentation의 Document.
 * 앞은 속성 `#02`, 뒤는 클래스 `#01`).
 *
 * 🔴 근거: 골든 파일 4종이 **모두** 이 형태를 6건씩 쓰고(Documents·DocumentIds·
 * DocumentClassifications·DocumentVersions… 항목), 같은 id의 CD도 함께 들어 있다.
 * 그중 `01-롤포밍기-공34.aasx`는 **KOSMO Validator 전 항목 Passed**다. 서버 린터도
 * 접두(`0173-`/`0112/`)만 보므로 통과시킨다 — 화면만 "형식이 표준과 다르다"고 경고해
 * 멀쩡한 표준 값에 경고를 띄우고 있었다.
 */
const IRDI_RE = new RegExp(`^${ONE_IRDI}(?:\\/${ONE_IRDI})?$`);
/** 복합형인가 — 안내 문구를 다르게 준다 */
const COMPOUND_IRDI_RE = new RegExp(`^${ONE_IRDI}\\/${ONE_IRDI}$`);

export function checkSemanticId(
  value: string,
  policy: { iriBase: string; irdiPrefixes: string[] },
  hasConceptDescription: boolean,
  /** 서브모델의 semanticId는 템플릿 IRI다 — 화이트리스트(SM-3)는 같지만 CD를 요구하지 않는다 */
  scope: 'element' | 'submodel' = 'element',
  /**
   * 번역기 — 안 주면 한국어 그대로.
   * 🔴 정책값이 섞인 문장이 있어 밖에서 `t(message)`로는 못 옮긴다(허용 목록 안내의 접두 목록).
   *    그래서 만드는 자리에서 옮긴다.
   */
  t: (text: string) => string = (text) => text,
): SemanticIdNote[] {
  const trimmed = value.trim();
  if (trimmed === '') {
    return [
      {
        level: 'error',
        message: t('semanticId가 없으면 {rule} 위반입니다.').replace(
          '{rule}',
          scope === 'submodel' ? 'KOSMO-SM-3' : 'KOSMO-SME-3',
        ),
      },
    ];
  }

  const notes: SemanticIdNote[] = [];
  const isIrdiPrefix = policy.irdiPrefixes.some((prefix) => trimmed.startsWith(prefix));

  if (isIrdiPrefix) {
    if (IRDI_RE.test(trimmed)) {
      notes.push({
        level: 'ok',
        message: COMPOUND_IRDI_RE.test(trimmed)
          ? t('표준 사전 IRDI 복합형입니다 — 「속성/클래스」를 이은 형식으로, IDTA 템플릿이 리스트 항목에 씁니다.')
          : t('표준 사전 IRDI 형식입니다.'),
      });
    } else {
      notes.push({
        level: 'warning',
        message: t('IRDI 접두는 맞지만 형식이 표준과 다릅니다. 사전에서 코드를 다시 확인하십시오.'),
      });
    }
    if (/-00(#|$)/.test(trimmed)) {
      notes.push({
        level: 'warning',
        message: t('eCl@ss 말미 -00 코드는 CDP에 존재하지 않습니다. 리프 클래스까지 전개해 재확인하십시오.'),
      });
    }
  } else if (trimmed.startsWith(`${policy.iriBase}/`)) {
    notes.push({ level: 'ok', message: t('자체 IRI 규약에 맞습니다.') });
  } else if (trimmed.startsWith('https://admin-shell.io/')) {
    notes.push({
      level: 'warning',
      message: t('IDTA 공식 IRI입니다. KOSMO Validator는 이를 거부합니다(규정 충돌 ①).'),
    });
  } else {
    notes.push({
      level: 'error',
      message: t('허용 목록 밖입니다. IRDI({prefixes}) 또는 {base}/... 형식이어야 합니다.')
        .replace('{prefixes}', policy.irdiPrefixes.join(' / '))
        .replace('{base}', policy.iriBase),
    });
  }

  if (!hasConceptDescription && scope === 'element') {
    notes.push({
      level: 'warning',
      message: t('이 id를 가진 ConceptDescription이 파일에 없습니다. 「자동 고치기」가 규약대로 만들어 줍니다.'),
    });
  }
  return notes;
}

export interface FindingTally {
  /** 이 노드에 직접 붙은 지적 */
  own: number;
  /** 자손까지 합친 수 */
  total: number;
  /** 자손까지 통틀어 가장 무거운 등급 */
  worst: Finding['severity'];
}

/**
 * 노드별 지적 집계.
 *
 * 접힌 노드에 자손의 지적이 보이지 않으면 **어디를 펼쳐야 할지 알 수 없다.**
 * 골든 파일의 CD 경고 2건이 접힌 그룹 안에 숨어 있던 것이 그 예다(2026-08-24, 화면에서 발견).
 * 참고(info)는 세지 않는다 — 고칠 것이 없는 사실은 배지가 아니라 지적 팝업의 「참고」 접힘에 있다.
 */
export function tallyFindings(
  roots: readonly TreeNode[],
  byNode: ReadonlyMap<string, Finding[]>,
): Map<string, FindingTally> {
  const out = new Map<string, FindingTally>();

  const visit = (node: TreeNode): FindingTally => {
    // 🔴 참고(info)는 배지에 세지 않는다 — 고칠 것이 없는 사실 전달인데 회색 숫자가 트리에 남아
    //    "경고 숫자가 남아 있다"고 읽혔다(2026-09-07). 배지는 위반·경고 수다(사용법 §3)
    const own = (byNode.get(node.pointer) ?? []).filter((finding) => finding.severity !== 'info');
    let total = own.length;
    let worst: Finding['severity'] = 'info';
    for (const finding of own) {
      if (severityRank(finding.severity) < severityRank(worst)) worst = finding.severity;
    }
    for (const child of node.children) {
      const childTally = visit(child);
      total += childTally.total;
      if (childTally.total > 0 && severityRank(childTally.worst) < severityRank(worst)) {
        worst = childTally.worst;
      }
    }
    const tally: FindingTally = { own: own.length, total, worst };
    out.set(node.pointer, tally);
    return tally;
  };

  for (const root of roots) visit(root);
  return out;
}

/** 요소 총수 — 요약 타일에 쓴다. 펼친 행 수는 화면 상태라 파일의 크기를 말해 주지 못한다 */
export function countElements(submodels: readonly Submodel[]): number {
  let total = 0;
  const walk = (nodes: readonly AasNode[]): void => {
    for (const node of nodes) {
      total += 1;
      const children = childrenOf(node);
      if (children) walk(children.items);
    }
  };
  for (const submodel of submodels) walk(submodel.submodelElements ?? []);
  return total;
}

export function severityRank(severity: Finding['severity']): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

/** key·depth를 옮겨 붙이고 전체를 보기 전용으로 표시한다 */
function relocate(node: TreeNode, prefix: string, depthShift: number, packageId: string): TreeNode {
  return {
    ...node,
    key: `${prefix}${node.key}`,
    pointer: `${prefix}${node.pointer}`, // 린터 finding과 절대 겹치지 않는 주소가 된다
    depth: node.depth + depthShift,
    linkedPackageId: packageId,
    children: node.children.map((child) => relocate(child, prefix, depthShift, packageId)),
  };
}

/** 다른 파일에서 읽어 온 한 단계 — 재귀라 자식이 또 이것일 수 있다(회사→공정→장비) */
export interface LinkedInfo {
  name: string;
  bulkCount: number;
  /** 공정·라인(파일 없는 층) — 왼쪽 트리에서 ▦로 그린다 */
  group?: boolean;
  /** 그 파일이 열려 있으면 채워진다 */
  packageId?: string;
  /** 그 파일이 공정(묶음)이면 — 밑은 다른 파일들이다. 아니면 밑은 그 설비의 부품(BoM)이다 */
  composite?: boolean;
  submodels?: Submodel[];
  /** 그 파일의 ConceptDescription — 지적(KOSMO-CD-*)이 가리킬 자리다 */
  concepts?: ConceptDescription[];
  children: LinkedInfo[];
}

/** 계층 서브모델(JSON)에서 자식 목록을 읽는다 — 서버 hierarchy API와 같은 해석이다 */
export interface HierarchyChild {
  name: string;
  /** 그룹(중간 마디)이면 빈 문자열 */
  globalAssetId: string;
  bulkCount: number;
  children: HierarchyChild[];
}

/** 계층 서브모델(JSON)에서 자식을 **중첩째** 읽는다 — 서버 hierarchy API와 같은 해석이다 */
export function childrenOfHierarchy(submodel: Submodel | undefined): HierarchyChild[] {
  const elements = (submodel?.submodelElements ?? []) as Record<string, unknown>[];
  const entry = elements.find((element) => element['modelType'] === 'Entity');
  if (!entry) return [];
  const walk = (holder: Record<string, unknown>): HierarchyChild[] => {
    const statements = (holder['statements'] ?? []) as Record<string, unknown>[];
    return statements
      .filter((element) => element['modelType'] === 'Entity')
      .map((element) => {
        const inner = (element['statements'] ?? []) as Record<string, unknown>[];
        const bulk = Number(inner.find((child) => child['idShort'] === 'BulkCount')?.['value']);
        return {
          name: String(element['idShort'] ?? ''),
          globalAssetId: String(element['globalAssetId'] ?? ''),
          bulkCount: Number.isFinite(bulk) && bulk > 0 ? bulk : 1,
          children: walk(element),
        };
      });
  };
  return walk(entry);
}

/**
 * 트리에 넣을 가지 — 「회사 → 공정 → 장비 → 장비별 서브모델」까지 재귀로.
 *
 * 🔴 파일에는 이 모양이 없다. 파일은 표준(IDTA-02011)대로 주소 참조뿐이고
 *    (포함형은 KOSMO-AAS-4 위반 — 실측 78건), **사람이 보는 트리에서만** 이어 붙인다.
 *    그래서 이 가지는 전부 linkedPackageId가 찍힌 보기 전용이다.
 *    자식이 또 계층 파일이면(⚙공정 안의 ⚙장비) 같은 방식으로 이어 붙는다.
 */
export function buildLinkedAsset(
  info: LinkedInfo,
  keyPrefix = '/linked',
  /** part: 이 가지가 설비의 부품(BoM)이다 — 설비 파일을 직접 열었을 때 맨 위 ⚙ 줄이 그 경우 */
  opts: { part?: boolean } = {},
): TreeNode {
  const key = `${keyPrefix}/${info.name}`;
  const depth = key.split('/').length - 1; // /linked/a → 1, /linked/a/b → 2
  const root: TreeNode = {
    key,
    label: info.bulkCount > 1 ? fill(tr('{0} ×{1}대'), { 0: info.name, 1: info.bulkCount }) : info.name,
    modelType: 'LinkedAsset',
    pointer: key,
    submodelId: '',
    depth,
    children: [],
    node: { idShort: info.name, modelType: 'LinkedAsset' } as AasNode,
    ...(info.packageId ? { linkedPackageId: info.packageId } : {}),
    ...(info.group ? { linkedGroup: true } : {}),
    ...(opts.part ? { linkedPart: true } : {}),
  };
  /**
   * 🔴 설비 파일(packageId 있음) 밑의 자식은 그 설비의 **부품**이다 — 「부품 (n)」 한 줄로 접어 둔다.
   *    공정 안에 설비가 여러 대면 부품 줄이 대마다 반복돼 세로로 길어지고, 종류가 같은 LinkedAsset이라
   *    설비로 헷갈렸다(사용자 2026-09-08). 공정(그룹)·예정 설비 밑의 자식은 설비 그대로다
   */
  const partsFolder = (): TreeNode[] => {
    if (!info.packageId || info.children.length === 0) return [];
    const folderKey = `${key}/__parts`;
    return [
      {
        key: folderKey,
        label: `BOM (${info.children.length})`, // 「부품」→「BOM」 — 사용자 지정(2026-09-09)
        modelType: 'LinkedAsset',
        pointer: folderKey,
        submodelId: '',
        depth: depth + 1,
        children: info.children.map((child) => buildLinkedAsset(child, folderKey, { part: true })),
        node: { idShort: tr('부품'), modelType: 'LinkedAsset' } as AasNode,
        linkedPartGroup: true,
      },
    ];
  };
  // 자식 가지(⚙·▦)가 먼저, 그다음 자기 서브모델 — 최상위와 같은 읽는 순서다.
  // 그룹(파일 없는 중간 마디)은 서브모델이 없지만 자식은 그린다 — 회사>공정>장비의 「공정」 자리다
  root.children = [
    ...(info.packageId ? partsFolder() : info.children.map((child) => buildLinkedAsset(child, key, opts))),
    ...(info.submodels && info.packageId
      ? buildTree({
          shells: [],
          submodels: info.submodels,
          conceptDescriptions: info.concepts ?? [],
        })
          // 🔴 ConceptDescription 그룹도 싣는다. 빼면 그 파일의 CD를 가리키는 지적
          //    (KOSMO-CD-5 등)을 눌러도 트리에 갈 곳이 없다 — "위치 표현이 안 된다"(실측)
          .filter(
            (node) =>
              node.modelType === 'Submodel' || node.modelType === 'ConceptDescriptionGroup',
          )
          .map((node) => relocate(node, key, depth + 1, info.packageId!))
      : []),
  ];
  return root;
}
