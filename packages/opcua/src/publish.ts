/**
 * 배포(Publish) 엔진 — 기획서 M7. **AAS 계층 → OPC UA 노드 트리**.
 *
 * 왜 이것이 있어야 하는가(기획서 Ⅱ-3):
 *   「BaSyx가 하는 일이 AASX를 임포트해 OPC UA 서버의 값을 채우는 것뿐이라면,
 *     중간 매개체를 두는 대신 **저작 도구 자체가 OPC UA 서버가 되는 것**이 단순하다」
 * 즉 우리는 설비에서 값을 긁어와(M8) 그 값을 **다시 내주는 중계소**가 된다.
 * REST(Part 2)로도 현재값은 읽히지만 그건 물어봐야 답한다 — 상위 앱 N개가 **구독**으로
 * 받아 가려면 OPC UA 서버가 있어야 한다(기획서 Ⅲ-3 「구독 기반 N개 앱 동시 배포」).
 *
 * 🔴 이 파일은 node-opcua를 부르지 않는다. **계획만 세운다** — 서버 없이 시험하기 위해서다.
 *    실체화는 server.ts가 한다(M6).
 *
 * 설계에서 정한 것 — 뒤집지 말 것:
 *  ① **NodeId는 Part 2 idShortPath와 같은 경로를 쓴다.** 같은 요소를 REST와 OPC UA에서
 *     다른 이름으로 부르면 현장에서 대조가 안 된다.
 *  ② **전부 읽기 전용이다.** 값 동기화 A안(파일이 원본) — OPC UA로 값을 바꿔 모델에 스며들면
 *     그 순간 A안이 깨진다. Package Explorer가 정확히 그 함정에 빠져 있다(§2-2).
 *  ③ **idShort가 없는 자식도 버리지 않는다.** SML 자식은 익명일 수 있다(AASd-120) —
 *     이름이 없다고 빼면 트리가 원본과 달라진다. 규격대로 `[n]`으로 가리킨다.
 */
import type { Environment, Submodel, SubmodelElement } from '@aas/core';

/** 우리가 쓰는 OPC UA 자료형 — 모델의 xs:* 를 이 다섯으로 좁힌다 */
export type OpcDataType = 'Boolean' | 'Double' | 'Int32' | 'Int64' | 'String';

export interface PublishNode {
  /** browseName. 형제끼리 겹치지 않는다 */
  name: string;
  /** ns=1;s=<이 값> — Part 2 idShortPath와 같은 경로다 */
  nodeId: string;
  kind: 'folder' | 'variable';
  /** variable일 때만 */
  dataType?: OpcDataType;
  /** AAS는 값을 문자열로 담는다. 형 변환은 서버가 한다 */
  value?: string;
  /** 어느 AAS 요소에서 왔는지 — 사람이 대조할 때 */
  modelType?: string;
  children: PublishNode[];
}

export interface PublishPlan {
  packageId: string;
  /** 폴더 이름 — 설비 이름 */
  name: string;
  children: PublishNode[];
  /** 실체화될 변수 수 — 로그와 시험의 근거 */
  variables: number;
}

/**
 * xs:* → OPC UA 자료형.
 *
 * 🔴 모르는 것은 String으로 떨어뜨린다. 숫자로 넘겨짚었다가 파싱에 실패하면
 *    **값이 조용히 사라진다** — 문자열로라도 보이는 편이 낫다.
 */
export function opcTypeOf(valueType: string | undefined): OpcDataType {
  switch (valueType) {
    case 'xs:boolean':
      return 'Boolean';
    case 'xs:double':
    case 'xs:decimal':
    case 'xs:float':
      return 'Double';
    case 'xs:int':
    case 'xs:integer':
    case 'xs:short':
    case 'xs:byte':
    case 'xs:unsignedShort':
    case 'xs:unsignedByte':
    case 'xs:negativeInteger':
    case 'xs:nonNegativeInteger':
    case 'xs:nonPositiveInteger':
    case 'xs:positiveInteger':
      return 'Int32';
    case 'xs:long':
    case 'xs:unsignedInt':
    case 'xs:unsignedLong':
      return 'Int64';
    default:
      return 'String';
  }
}

/** 값이 실려 나가는 종류. 담는 요소는 폴더가 된다 */
const VALUED = new Set(['Property', 'MultiLanguageProperty', 'Range', 'Blob', 'File']);

function childrenOf(node: SubmodelElement): { items: SubmodelElement[]; isList: boolean } | undefined {
  const record = node as unknown as Record<string, unknown>;
  if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
    const items = Array.isArray(record['value']) ? (record['value'] as SubmodelElement[]) : [];
    return { items, isList: node.modelType === 'SubmodelElementList' };
  }
  if (node.modelType === 'Entity') {
    const items = Array.isArray(record['statements']) ? (record['statements'] as SubmodelElement[]) : [];
    return { items, isList: false };
  }
  return undefined;
}

/** 요소에서 내보낼 값 문자열 하나를 고른다 */
function valueOf(node: SubmodelElement): string | undefined {
  const record = node as unknown as Record<string, unknown>;
  if (node.modelType === 'MultiLanguageProperty') {
    // 첫 언어를 쓴다. OPC UA 쪽에 언어 개념을 억지로 옮기지 않는다
    const list = record['value'];
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const first = list[0] as { text?: unknown };
    return typeof first?.text === 'string' ? first.text : undefined;
  }
  if (node.modelType === 'Range') {
    // 구간은 하나의 값이 아니다 — 사람이 읽을 수 있게 붙여 둔다
    const min = record['min'];
    const max = record['max'];
    if (min === undefined && max === undefined) return undefined;
    return `${String(min ?? '')}..${String(max ?? '')}`;
  }
  const value = record['value'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 형제끼리 이름이 겹치지 않게 한다.
 *
 * 🔴 OPC UA는 같은 부모 밑에서 browseName이 겹치면 **덮어써 잃는다.**
 *    AAS는 idShort 중복을 허용하는 결함 파일이 실제로 있다(KOSMO 실측) —
 *    그런 파일이 들어와도 노드가 사라지지 않아야 한다.
 */
function uniqueName(taken: Set<string>, wanted: string): string {
  if (!taken.has(wanted)) {
    taken.add(wanted);
    return wanted;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${wanted}_${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

function buildElements(
  items: readonly SubmodelElement[],
  parentIsList: boolean,
  parentPath: string,
  prefix: string,
  counter: { variables: number },
): PublishNode[] {
  const taken = new Set<string>();
  return items.map((node, index) => {
    // SML의 자식은 규격상 인덱스로 가리킨다(익명일 수 있다) — model.ts와 같은 규칙
    const name = uniqueName(taken, node.idShort ?? `[${index}]`);
    // 🔴 경로 조각도 **겹치지 않게 한 이름**을 쓴다. idShort 중복은 실제로 있는 결함이고
    //    (KOSMO-CD-5), 그대로 두면 NodeId가 겹쳐 노드 하나가 통째로 사라진다.
    //    정상 파일에서는 name === idShort라 Part 2 idShortPath와 한 글자도 다르지 않다.
    const segment = parentIsList ? `[${index}]` : name;
    // 🔴 최상위에는 앞의 '.'을 붙이지 않는다
    const path = parentIsList
      ? `${parentPath}${segment}`
      : parentPath === ''
        ? segment
        : `${parentPath}.${segment}`;

    const nested = childrenOf(node);
    if (nested && !VALUED.has(node.modelType)) {
      return {
        name,
        nodeId: `${prefix}${path}`,
        kind: 'folder' as const,
        modelType: node.modelType,
        children: buildElements(nested.items, nested.isList, path, prefix, counter),
      };
    }

    counter.variables += 1;
    const value = valueOf(node);
    const valueType = (node as unknown as Record<string, unknown>)['valueType'];
    return {
      name,
      nodeId: `${prefix}${path}`,
      kind: 'variable' as const,
      // Range·MLP는 xs 자료형이 없거나 뜻이 달라 문자열로 낸다
      dataType:
        node.modelType === 'Property' ? opcTypeOf(typeof valueType === 'string' ? valueType : undefined) : 'String',
      ...(value === undefined ? {} : { value }),
      modelType: node.modelType,
      children: [],
    };
  });
}

/** 서브모델 하나를 폴더 하나로 */
export function planForSubmodel(
  submodel: Submodel,
  packageId: string,
  counter: { variables: number },
  taken: Set<string>,
): PublishNode {
  // 🔴 idShort가 없는 서브모델도 있다. id로 가리켜 트리에서 사라지지 않게 한다
  const label = submodel.idShort ?? submodel.id;
  const prefix = `${packageId}/${submodel.id}/`;
  return {
    name: uniqueName(taken, label),
    nodeId: `${packageId}/${submodel.id}`,
    kind: 'folder',
    modelType: 'Submodel',
    children: buildElements(submodel.submodelElements ?? [], false, '', prefix, counter),
  };
}

/**
 * 파일 한 벌을 노드 계획으로.
 *
 * 값을 얹으려면 `overlayEnvironment`로 수집값을 덧씌운 Environment를 넘긴다 —
 * 이 함수는 **모델에 적힌 것을 그대로** 옮길 뿐, 시계열을 따로 읽지 않는다.
 * (두 곳에서 값을 고르면 REST와 OPC UA가 다른 값을 말하게 된다)
 */
export function planForPackage(
  environment: Environment,
  options: { packageId: string; name?: string },
): PublishPlan {
  const counter = { variables: 0 };
  const taken = new Set<string>();
  const children = (environment.submodels ?? []).map((submodel) =>
    planForSubmodel(submodel, options.packageId, counter, taken),
  );
  // 이름은 AAS의 idShort가 가장 사람 말에 가깝다. 없으면 파일명
  const shell = environment.assetAdministrationShells?.[0];
  return {
    packageId: options.packageId,
    name: shell?.idShort ?? options.name ?? options.packageId,
    children,
    variables: counter.variables,
  };
}

/** 계획 안의 모든 변수 노드를 평평하게 — 서버가 값을 갱신할 때 쓴다 */
export function flattenVariables(plan: PublishPlan): PublishNode[] {
  const out: PublishNode[] = [];
  const walk = (nodes: readonly PublishNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'variable') out.push(node);
      walk(node.children);
    }
  };
  walk(plan.children);
  return out;
}
