/**
 * 모델 — 공정 화면의 연결 파일 가지 — 다른 파일의 서브모델을 트리에 이어 붙인다.
 * src/model.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 model.ts 로 쓴다.
 */
import { fill, tr } from '../i18n.js';
import { type AasNode, type ConceptDescription, type Submodel, type TreeNode } from './types.js';
import { buildTree } from './tree.js';

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
  /** 그 그룹이 라인 층인가(회사 → 라인 → 공정 → 설비) */
  line?: boolean;
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
  // 맨 앞 빈 조각('')과 'linked' 를 빼고 센다 — 예전에는 하나 더 세어 이 가지만 한 단계 더 들어가 있었다(2026-10-14)
  const depth = key.split('/').length - 2; // /linked/a → 1, /linked/a/b → 2
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
    ...(info.line ? { linkedLine: true, typeNote: tr('라인') } : {}),
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
