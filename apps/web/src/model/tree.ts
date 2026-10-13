/**
 * 모델 — 트리 만들기 · 펼친 줄 · 찾기 · 지적 자리까지 펼치기 · 값 표시 · 요소 세기.
 * src/model.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 model.ts 로 쓴다.
 */
import { type AasNode, type Environment, type Submodel, type TreeNode } from './types.js';

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
