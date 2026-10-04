/**
 * XML 직렬화 AASX 읽기.
 *
 * 왜 필요한가: Package Explorer를 비롯한 기존 도구가 **XML로 저장한 AASX**를 흔히 준다.
 * 열지 못하면 "대체품"이라고 할 수 없다. 쓰기는 계속 JSON으로만 한다(무손실 왕복 경로를 둘로 늘리지 않는다).
 *
 * 규격의 XML↔JSON 대응에서 까다로운 것은 셋이다.
 *  ① **종류가 요소 이름에 실린다.** `<property>` → `modelType: 'Property'`.
 *     JSON에는 `modelType` 필드가 있어야 하므로 여기서 만들어 넣는다
 *  ② **순서를 잃으면 안 된다.** SubmodelElementList는 자식을 **순서로 가리킨다**(AASd-120).
 *     이름별로 묶는 파서는 서로 다른 종류가 섞인 자리에서 순서를 잃는다 →
 *     `preserveOrder: true`로 문서 순서 그대로 읽는다
 *  ③ 같은 이름(`<value>`)이 자리마다 뜻이 다르다. Property에서는 글자, SMC에서는 자식 목록,
 *     MultiLanguageProperty에서는 언어별 글자다 → **자식이 요소면 배열, 글자면 문자열**로 가른다
 */
import { XMLParser } from 'fast-xml-parser';
import type { Environment } from '@aas/core';

/** 문서 순서를 지키는 파서. 이름공간 접두사(aas:)는 떼고 읽는다 */
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  removeNSPrefix: true,
  // 🔴 값을 다듬지 않는다. 남의 파일을 여는 경로다 — 글자 끝의 공백 하나도 우리가 지울 것이 아니다.
  //    (실측: 골든 파일의 독일어 설명 5건이 공백으로 끝난다. trim하면 조용히 달라진다)
  trimValues: false,
  parseTagValue: false, // 숫자처럼 보이는 값도 글자 그대로 — id·버전이 숫자로 바뀌면 안 된다
});

/** preserveOrder가 주는 노드: 키 하나짜리 객체 */
type XmlNode = Record<string, unknown>;

const TEXT = '#text';

function nameOf(node: XmlNode): string {
  const keys = Object.keys(node).filter((key) => key !== ':@');
  return keys[0] ?? '';
}

function childrenOf(node: XmlNode): XmlNode[] {
  const value = node[nameOf(node)];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

/**
 * 요소 자식이 하나도 없고 글자만 있는가.
 *
 * 들여쓴 XML에서는 `<a>\n  <b/>\n</a>`처럼 **요소 사이의 줄바꿈**이 글자 노드로 들어온다.
 * 그건 값이 아니라 생김새이므로 빈 요소로 본다 — 다만 그 판정은 **줄바꿈이 있을 때만** 한다.
 * 값이 진짜 공백으로 끝나는 경우와 구분해야 하기 때문이다.
 */
function textOf(children: XmlNode[]): string | undefined {
  if (children.length === 0) return '';
  if (children.length === 1 && TEXT in children[0]!) {
    const text = String(children[0]![TEXT] ?? '');
    if (text.includes('\n') && text.trim() === '') return '';
    return text;
  }
  return undefined;
}

/**
 * 이름이 곧 종류인 요소들.
 * 이 이름으로 나타나면 `modelType`을 만들어 넣는다.
 */
const MODEL_TYPES = new Set([
  'assetAdministrationShell',
  'submodel',
  'conceptDescription',
  'property',
  'multiLanguageProperty',
  'range',
  'blob',
  'file',
  'referenceElement',
  'relationshipElement',
  'annotatedRelationshipElement',
  'submodelElementCollection',
  'submodelElementList',
  'entity',
  'capability',
  'operation',
  'basicEventElement',
]);

/**
 * 감싸개 안에서 **반복되는 항목**의 이름.
 * 하나만 있어도 배열이어야 한다 — 개수로 판정하면 1건짜리 목록이 객체가 되어 조용히 어긋난다.
 */
const ITEM_NAMES = new Set([
  ...MODEL_TYPES,
  'key',
  'reference',
  'specificAssetId',
  'extension',
  'qualifier',
  'embeddedDataSpecification',
  'valueReferencePair',
  'langStringNameType',
  'langStringTextType',
  'langStringPreferredNameTypeIec61360',
  'langStringShortNameTypeIec61360',
  'langStringDefinitionTypeIec61360',
  'operationVariable',
]);

/**
 * 자식 **하나**가 종류를 말하는 자리.
 * `<dataSpecificationContent><dataSpecificationIec61360>…` → JSON에서는
 * `dataSpecificationContent: { modelType: 'DataSpecificationIec61360', … }` 하나짜리 객체다.
 * 목록으로 읽으면 배열이 되어 스키마가 어긋난다(실측으로 잡았다).
 */
const TYPED_SINGLE_WRAPPERS = new Set(['dataSpecificationContent']);
const TYPED_CONTENT_NAMES = new Set(['dataSpecificationIec61360']);

/** 참(true)·거짓(false)으로 읽어야 하는 자리 — 글자로 두면 스키마가 어긋난다 */
const BOOLEAN_FIELDS = new Set(['orderRelevant', 'min', 'max', 'nom', 'typ']);

/** `langStringTextType` → `LangStringTextType`이 아니라, JSON에서는 이름 없는 객체다 */
const UNNAMED_ITEMS = new Set([
  'key',
  'reference',
  'specificAssetId',
  'extension',
  'qualifier',
  'embeddedDataSpecification',
  'valueReferencePair',
  'langStringNameType',
  'langStringTextType',
  'langStringPreferredNameTypeIec61360',
  'langStringShortNameTypeIec61360',
  'langStringDefinitionTypeIec61360',
  'operationVariable',
]);

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** 요소 하나를 JSON 값으로 바꾼다 */
function toValue(node: XmlNode, field: string): unknown {
  const children = childrenOf(node);
  const text = textOf(children);
  if (text !== undefined) {
    if (BOOLEAN_FIELDS.has(field)) return text === 'true';
    return text;
  }

  const out: Record<string, unknown> = {};
  // 이름이 곧 종류인 자리에서는 modelType을 만들어 넣는다(JSON에는 있어야 한다)
  const own = nameOf(node);
  if (MODEL_TYPES.has(own) && !UNNAMED_ITEMS.has(own)) out['modelType'] = pascal(own);

  for (const child of children) {
    const childName = nameOf(child);
    if (childName === '' || childName === TEXT) continue;
    const grandChildren = childrenOf(child);

    const items = grandChildren.filter((g) => !(TEXT in g));

    // 자식 하나가 종류를 말하는 자리 — 배열이 아니라 객체 하나다
    if (TYPED_SINGLE_WRAPPERS.has(childName) && items.length === 1) {
      const only = items[0]!;
      const converted = toValue(only, nameOf(only)) as Record<string, unknown>;
      if (TYPED_CONTENT_NAMES.has(nameOf(only))) converted['modelType'] = pascal(nameOf(only));
      out[childName] = converted;
      continue;
    }

    // 감싸개인가 — 자식이 전부 「항목 이름」이면 배열이다
    const allItems = items.length > 0 && items.every((g) => ITEM_NAMES.has(nameOf(g)));
    if (allItems) {
      out[childName] = items.map((item) => toValue(item, nameOf(item)));
      continue;
    }
    out[childName] = toValue(child, childName);
  }
  return out;
}

/** 최상위 감싸개(`<submodels>` 등)를 배열로 편다 */
function toList(node: XmlNode): unknown[] {
  return childrenOf(node)
    .filter((child) => !(TEXT in child))
    .map((child) => toValue(child, nameOf(child)));
}

export class AasxXmlError extends Error {}

/**
 * XML 본문을 Environment로 바꾼다.
 * 🔴 여기서 만든 것은 **읽기 전용 경로**다. 저장은 JSON으로 다시 쓴다(writeAasx).
 */
export function parseEnvironmentXml(text: string): Environment {
  let tree: XmlNode[];
  try {
    tree = parser.parse(text) as XmlNode[];
  } catch (error) {
    throw new AasxXmlError(`XML을 해석하지 못했습니다: ${String(error)}`);
  }

  const root = tree.find((node) => nameOf(node) === 'environment');
  if (!root) throw new AasxXmlError('<environment> 요소가 없습니다.');

  const environment: Record<string, unknown> = {};
  for (const child of childrenOf(root)) {
    const name = nameOf(child);
    if (name === 'assetAdministrationShells' || name === 'submodels' || name === 'conceptDescriptions') {
      const list = toList(child);
      // 🔴 빈 배열은 넣지 않는다 — 공식 스키마가 허용하지 않는다(PKG-EMPTY-ARRAY)
      if (list.length > 0) environment[name] = list;
    }
  }
  return environment as unknown as Environment;
}
