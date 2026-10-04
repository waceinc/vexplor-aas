/**
 * AID(Asset Interface Description) 서브모델 해석 — 기획서 M8의 출발점.
 *
 * "PLC의 D100 값을 어느 Property에 넣을 것인가"는 어떤 표준에도 없다(AAS_OPC UA.md §7-1).
 * 그래서 자체 매핑 테이블을 만들고 싶어지지만, **IDTA에 등가 템플릿이 있으면 자체 서브모델은
 * 허용되지 않는다**(KTL 모델링 규칙). 조사 결과 AID가 바로 그 템플릿이고,
 * **AID 1.1이 OPC UA를 지원**한다(IDTA-02017, W3C WoT Thing Description 기반).
 * → 자체 매핑을 만들지 않고 **AAS 안의 AID를 읽는다.**
 *
 * 구조(IDTA-02017-1-0 템플릿 실측)
 *   AssetInterfacesDescription (Submodel)
 *   └ InterfaceTemplateFor<PROTO> (SMC)
 *      ├ EndpointMetadata (SMC) — base(접속 주소) · contentType · security
 *      └ InteractionMetadata (SMC)
 *         └ properties (SMC)
 *            └ <이름> (SMC) — key · type · unit · observable …
 *               └ forms (SMC) — href(주소) · contentType · 프로토콜 고유 항목
 *
 * 🔴 AID 1.1의 OPC UA 고유 항목(용어 이름)은 발행본으로 확인해야 한다. 그래서 forms의
 * 나머지 항목은 **이름을 가리지 않고 그대로 담아 둔다**(formFields) — 규격이 확정되면 그 자리를 읽는다.
 */
import type { Environment, Submodel, SubmodelElement } from '@aas/core';

/** AID 서브모델의 semanticId (버전 자리는 느슨하게 본다) */
export const AID_SEMANTIC_ID_PREFIX = 'https://admin-shell.io/idta/AssetInterfacesDescription/';

export type AidProtocol = 'OPCUA' | 'HTTP' | 'MODBUS' | 'MQTT' | 'UNKNOWN';

export interface AidProperty {
  /** 화면·저장에 쓰는 이름 (요소의 idShort) */
  name: string;
  /** AID의 key — 자산 쪽 식별자 */
  key?: string;
  /** float · integer · string · boolean … (WoT 타입) */
  type?: string;
  unit?: string;
  observable: boolean;
  /** 읽을 주소. OPC UA면 NodeId, HTTP면 경로 */
  href?: string;
  /** forms 안의 나머지 항목 — 프로토콜 고유(htv_*, modv_*, opc_* …) */
  formFields: Record<string, string>;
}

export interface AidInterface {
  /** 요소 idShort (예: InterfaceTemplateForOPCUA) */
  name: string;
  title?: string;
  protocol: AidProtocol;
  /** 접속 주소. OPC UA면 opc.tcp://… */
  base?: string;
  properties: AidProperty[];
}

function children(node: SubmodelElement | undefined): SubmodelElement[] {
  if (!node) return [];
  const value = (node as { value?: unknown }).value;
  return Array.isArray(value) ? (value as SubmodelElement[]) : [];
}

function child(node: SubmodelElement | undefined, idShort: string): SubmodelElement | undefined {
  return children(node).find((c) => c.idShort === idShort);
}

function text(node: SubmodelElement | undefined): string | undefined {
  const value = (node as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 이름에서 프로토콜을 읽는다. AID는 InterfaceTemplateFor<PROTO> 관례를 쓴다 */
export function protocolOf(name: string, base?: string): AidProtocol {
  const upper = name.toUpperCase();
  if (upper.includes('OPCUA') || upper.includes('OPC_UA') || base?.startsWith('opc.tcp')) return 'OPCUA';
  if (upper.includes('MODBUS') || base?.startsWith('modbus')) return 'MODBUS';
  if (upper.includes('MQTT') || base?.startsWith('mqtt')) return 'MQTT';
  if (upper.includes('HTTP') || base?.startsWith('http')) return 'HTTP';
  return 'UNKNOWN';
}

/** Environment에서 AID 서브모델을 찾는다. semanticId로 찾고, 없으면 idShort로 한 번 더 본다 */
export function findAidSubmodels(environment: Environment): Submodel[] {
  return (environment.submodels ?? []).filter((submodel) => {
    const semantic = submodel.semanticId?.keys?.[0]?.value ?? '';
    if (semantic.startsWith(AID_SEMANTIC_ID_PREFIX)) return true;
    return submodel.idShort === 'AssetInterfacesDescription';
  });
}

/** AID 서브모델 하나를 인터페이스 목록으로 편다 */
export function parseAidSubmodel(submodel: Submodel): AidInterface[] {
  const out: AidInterface[] = [];

  for (const node of submodel.submodelElements ?? []) {
    if (node.modelType !== 'SubmodelElementCollection') continue;
    const endpoint = child(node, 'EndpointMetadata');
    const interaction = child(node, 'InteractionMetadata');
    // 둘 중 하나도 없으면 인터페이스가 아니다(제목만 있는 컬렉션 등)
    if (!endpoint && !interaction) continue;

    const base = text(child(endpoint, 'base'));
    const name = node.idShort ?? '(이름 없음)';
    const properties: AidProperty[] = [];

    for (const property of children(child(interaction, 'properties'))) {
      const forms = child(property, 'forms');
      const formFields: Record<string, string> = {};
      for (const field of children(forms)) {
        const value = text(field);
        if (field.idShort && value && field.idShort !== 'href') formFields[field.idShort] = value;
      }

      const entry: AidProperty = {
        name: property.idShort ?? '(이름 없음)',
        observable: text(child(property, 'observable')) === 'true',
        formFields,
      };
      const key = text(child(property, 'key'));
      if (key) entry.key = key;
      const type = text(child(property, 'type'));
      if (type) entry.type = type;
      const unit = text(child(property, 'unit'));
      if (unit) entry.unit = unit;
      const href = text(child(forms, 'href'));
      if (href) entry.href = href;

      properties.push(entry);
    }

    const descriptor: AidInterface = { name, protocol: protocolOf(name, base), properties };
    const title = text(child(node, 'title'));
    if (title) descriptor.title = title;
    if (base) descriptor.base = base;
    out.push(descriptor);
  }

  return out;
}

/** Environment 전체에서 인터페이스를 모은다 */
export function parseAid(environment: Environment): AidInterface[] {
  return findAidSubmodels(environment).flatMap((submodel) => parseAidSubmodel(submodel));
}

/** 실제로 읽을 수 있는 항목만 — 주소가 없으면 수집할 수 없다 */
export function readableProperties(descriptor: AidInterface): AidProperty[] {
  return descriptor.properties.filter((property) => property.href !== undefined);
}
