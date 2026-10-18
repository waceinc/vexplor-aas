/**
 * Building the AID submodel — where the UI creates a "collection connection".
 *
 * Why: collection requires an AID (IDTA-02017) inside the file, but its structure is
 * nested 4–5 levels deep, so building it by hand via "Add element" is practically impossible. Until now
 * it could only be created by demo scripts — meaning there was no way to attach real equipment.
 *
 * Important: semanticIds are taken **verbatim from the official IDTA template (IDTA-02017-1-0).**
 *    Hand-written ones miss the standard terms, and KOSMO-SME-3 fires once per element (observed).
 * Important: an AID built here must always be readable back by `parseAid()` —
 *    if build and parse diverge, you get "created it but collection doesn't work". Tests pin the round trip.
 */
import type { SubmodelElement } from '@aas/core';
import { fill, tr } from '@aas/core';
import { AidBuildError, prop, ref, smc } from './aid-build-parts.js';
import { checkSecurity, securityElements, securityTerms, type AidSecurityInput } from './aid-build-security.js';

export { AidBuildError } from './aid-build-parts.js';
export { OPCUA_POLICIES, type AidSecurityInput } from './aid-build-security.js';

/** Standard semanticIds from the IDTA-02017-1-0 template */
const TERM = {
  interface: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Interface',
  endpointMetadata: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/EndpointMetadata',
  base: 'https://www.w3.org/2019/wot/td#baseURI',
  contentType: 'https://www.w3.org/2019/wot/hypermedia#forContentType',
  interactionMetadata:
    'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/InteractionMetadata',
  properties: 'https://www.w3.org/2019/wot/td#PropertyAffordance',
  propertyDefinition:
    'https://admin-shell.io/idta/AssetInterfaceDescription/1/0/PropertyDefinition',
  key: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/key',
  type: 'https://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  title: 'https://www.w3.org/2019/wot/td#title',
  observable: 'https://www.w3.org/2019/wot/td#isObservable',
  unit: 'https://schema.org/unitCode',
  forms: 'https://www.w3.org/2019/wot/td#hasForm',
  href: 'https://www.w3.org/2019/wot/hypermedia#hasTarget',
} as const;

export interface AidTagInput {
  /**
   * Item name — becomes the element's idShort.
   * Important: it must **match** the model element's idShort for collected values to be served via the standard API (`live=true`).
   */
  name: string;
  /** Address to read. NodeId for OPC UA (e.g. ns=1;s=Machine.MotorSpeed) */
  href: string;
  /** Asset-side identifier (e.g. PLC address D100). Optional */
  key?: string;
  /** float · integer · string · boolean */
  type?: string;
  /** UCUM unit (rpm · Cel · ea …) */
  unit?: string;
  /**
   * Protocol-specific form fields (2026-10-14) — Modbus uses modv_* (entity · function · type · byte order · unitID),
   * MQTT uses mqv_* (controlPacket · qos · retain). Only names listed in FORM_FIELDS are accepted. Not used for OPC UA.
   */
  form?: Readonly<Record<string, string>>;
}

/** Protocol determined from the endpoint address — also used to name the AID interface (pairs with protocolOf in parseAid) */
export type AidBuildProtocol = 'OPCUA' | 'MODBUS' | 'MQTT';
export function endpointProtocol(endpoint: string): AidBuildProtocol | undefined {
  if (/^opc\.tcp:\/\/.+/i.test(endpoint)) return 'OPCUA';
  if (/^modbus\+tcp:\/\/.+/i.test(endpoint)) return 'MODBUS';
  if (/^mqtts?:\/\/.+/i.test(endpoint)) return 'MQTT';
  return undefined;
}

const INTERFACE_NAME: Record<AidBuildProtocol, string> = {
  OPCUA: 'InterfaceTemplateForOPCUA',
  MODBUS: 'InterfaceTemplateForModbus',
  MQTT: 'InterfaceTemplateForMQTT',
};
const PROTOCOL_LABEL: Record<AidBuildProtocol, string> = { OPCUA: 'OPC UA', MODBUS: 'Modbus TCP', MQTT: 'MQTT' };

/**
 * Form fields and their vocabulary (W3C WoT bindings). The source spec defines only the namespace, not per-field IRIs —
 * so we do not invent field IRIs; we attach our own IRI (cd/{name}) plus the namespace IRI as supplemental.
 */
const MODBUS_NS = 'https://www.w3.org/2019/wot/modbus';
const MQTT_NS = 'https://www.w3.org/2019/wot/mqtt';
/**
 * Read period of an interface (2.8.0) — on every form, in ms. Modbus has the binding's own term (`modv:pollingTime`);
 * the OPC UA and MQTT bindings have none, so they carry ours (`vxp_pollingTime`, this tool's vocabulary).
 */
export const POLLING_FIELD: Record<AidBuildProtocol, string> = { MODBUS: 'modv_pollingTime', OPCUA: 'vxp_pollingTime', MQTT: 'vxp_pollingTime' };
const POLLING_NS: Record<string, string> = { modv_pollingTime: MODBUS_NS, vxp_pollingTime: 'urn:vexplor:aid:pollingTime' };
/** The bounds the edge approval accepts for a read interval (routes-edge-admin.ts) */
export const POLLING_MS = { min: 100, max: 3_600_000 } as const;
const FORM_FIELDS: Record<string, { protocol: AidBuildProtocol; ns: string; values?: readonly string[] }> = {
  modv_entity: { protocol: 'MODBUS', ns: MODBUS_NS, values: ['Coil', 'DiscreteInput', 'HoldingRegister', 'InputRegister'] },
  modv_function: { protocol: 'MODBUS', ns: MODBUS_NS, values: ['readCoil', 'readDeviceDiscreteInput', 'readHoldingRegisters', 'readInputRegisters'] },
  modv_type: { protocol: 'MODBUS', ns: MODBUS_NS },
  modv_mostSignificantByte: { protocol: 'MODBUS', ns: MODBUS_NS, values: ['true', 'false'] },
  modv_mostSignificantWord: { protocol: 'MODBUS', ns: MODBUS_NS, values: ['true', 'false'] },
  modv_unitID: { protocol: 'MODBUS', ns: MODBUS_NS },
  mqv_controlPacket: { protocol: 'MQTT', ns: MQTT_NS, values: ['subscribe'] },
  mqv_qos: { protocol: 'MQTT', ns: MQTT_NS, values: ['0', '1'] },
  mqv_retain: { protocol: 'MQTT', ns: MQTT_NS, values: ['true', 'false'] },
};

export interface AidBuildInput {
  /** Equipment name — the AAS idShort. Included in the submodel id */
  assetName: string;
  /** Root of KOSMO's own IRIs */
  iriBase: string;
  /** Endpoint address — opc.tcp:// · modbus+tcp:// · mqtt:// · mqtts:// */
  endpoint: string;
  tags: readonly AidTagInput[];
  /** Interface display name. Defaults to "{equipment name} control panel (OPC UA)" */
  title?: string;
  /** Security the device wants (2.8.0) — OPC UA mode · policy, and a login for OPC UA and MQTT. Never a secret */
  security?: AidSecurityInput;
  /** How often to read this interface, ms (2.8.0). Absent: the server's default */
  intervalMs?: number;
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const TYPES = new Set(['float', 'integer', 'string', 'boolean']);

/** Validates input first — better to stop here than to build a wrong AID and then fail to collect */
export function checkAidInput(input: AidBuildInput): void {
  const protocol = endpointProtocol(input.endpoint);
  if (!protocol) {
    throw new AidBuildError(
      fill(tr('접속 주소는 opc.tcp:// · modbus+tcp:// · mqtt:// 중 하나로 시작해야 합니다: {0}'), { 0: input.endpoint }),
    );
  }
  // Important: a user name or password in the address would be stored in the file and handed out in the edge read list
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(input.endpoint.trim())) {
    throw new AidBuildError(tr('접속 주소에 사용자 이름 · 암호를 넣지 마십시오 — 「로그인 필요」를 켜고, 사용자 이름 · 암호는 서버의 credentials 파일(OPCUA_CLIENT_CREDENTIALS)과 공장 PC 의 credentials.json 에 이 주소로 적습니다.'));
  }
  checkSecurity(protocol, input.security);
  if (input.intervalMs !== undefined && (!Number.isInteger(input.intervalMs) || input.intervalMs < POLLING_MS.min || input.intervalMs > POLLING_MS.max)) {
    throw new AidBuildError(fill(tr('읽기 주기는 {0}ms ~ {1}ms 사이의 정수여야 합니다: {2}'), { 0: POLLING_MS.min, 1: POLLING_MS.max, 2: String(input.intervalMs) }));
  }
  if (input.tags.length === 0) throw new AidBuildError(tr('태그가 하나도 없습니다.'));
  const seen = new Set<string>();
  for (const tag of input.tags) {
    if (!NAME_PATTERN.test(tag.name)) {
      throw new AidBuildError(
        fill(tr('태그 이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: {0}'), { 0: tag.name }),
      );
    }
    if (seen.has(tag.name)) throw new AidBuildError(fill(tr('태그 이름이 겹칩니다: {0}'), { 0: tag.name }));
    seen.add(tag.name);
    // Important: a missing href (direct API calls) used to cause a 500 — now reported as 400, same as an empty address (2026-09-30)
    if (typeof tag.href !== 'string' || tag.href.trim() === '') {
      throw new AidBuildError(fill(tr('{0}의 읽을 주소(NodeId)가 비었습니다.'), { 0: tag.name }));
    }
    // Address format — Modbus: "address" or "unit/address" (+ ?quantity=n); MQTT: a topic without wildcards (reads the last value)
    if (protocol === 'MODBUS' && !/^(modbus\+tcp:\/\/[^/]+)?\/?(\d+\/)?\d+(\?quantity=\d+)?$/i.test(tag.href.trim())) {
      throw new AidBuildError(fill(tr('{0}의 Modbus 주소가 이상합니다: {1} — 예: 40 · 1/40 · 1/40?quantity=2'), { 0: tag.name, 1: tag.href }));
    }
    if (protocol === 'MQTT' && /[+#]/.test(tag.href)) {
      throw new AidBuildError(fill(tr('{0}의 MQTT 토픽에 와일드카드(+ #)를 쓸 수 없습니다: {1}'), { 0: tag.name, 1: tag.href }));
    }
    for (const [key, value] of Object.entries(tag.form ?? {})) {
      const rule = FORM_FIELDS[key];
      if (!rule || rule.protocol !== protocol) throw new AidBuildError(fill(tr('{0}에 쓸 수 없는 폼 항목입니다: {1}'), { 0: tag.name, 1: key }));
      if (rule.values && !rule.values.includes(value)) {
        throw new AidBuildError(
          fill(tr('{0}의 {1} 값이 이상합니다: {2} — 쓸 수 있는 것: {3}'), { 0: tag.name, 1: key, 2: value, 3: rule.values.join(' · ') }),
        );
      }
    }
    if (tag.type !== undefined && !TYPES.has(tag.type)) {
      throw new AidBuildError(
        fill(tr('{0}의 타입이 이상합니다: {1} — 쓸 수 있는 것: {2}'), { 0: tag.name, 1: tag.type, 2: [...TYPES].join(' · ') }),
      );
    }
  }
}

/**
 * Builds the AID submodel.
 * Important: the submodel's semanticId uses its own id — KOSMO rejects admin-shell.io IRIs (rule conflict ①).
 */
export function buildAidSubmodel(input: AidBuildInput): Record<string, unknown> {
  const base = input.iriBase;
  checkAidInput(input);
  const id = `${input.iriBase}/sm/${input.assetName}/AssetInterfacesDescription/1/0`;
  const protocol = endpointProtocol(input.endpoint)!;

  return {
    modelType: 'Submodel',
    id,
    idShort: 'AssetInterfacesDescription',
    kind: 'Template',
    administration: { version: '1', revision: '0' },
    semanticId: ref(id),
    submodelElements: [
      smc(base, INTERFACE_NAME[protocol], TERM.interface, [
        prop(base, 'title', TERM.title, input.title ?? fill(tr('{0} 제어반 ({1})'), { 0: input.assetName, 1: PROTOCOL_LABEL[protocol] })),
        smc(base, 'EndpointMetadata', TERM.endpointMetadata, [
          prop(base, 'base', TERM.base, input.endpoint),
          prop(base, 'contentType', TERM.contentType, 'application/json'),
          ...securityElements(base, id, INTERFACE_NAME[protocol], protocol, input.security),
        ]),
        smc(base, 'InteractionMetadata', TERM.interactionMetadata, [
          smc(
            base,
            'properties',
            TERM.properties,
            input.tags.map((tag) =>
              smc(base, tag.name, TERM.propertyDefinition, [
                ...(tag.key ? [prop(base, 'key', TERM.key, tag.key)] : []),
                prop(base, 'type', TERM.type, tag.type ?? 'string'),
                prop(base, 'title', TERM.title, tag.name),
                prop(base, 'observable', TERM.observable, 'true'),
                ...(tag.unit ? [prop(base, 'unit', TERM.unit, tag.unit)] : []),
                smc(base, 'forms', TERM.forms, [
                  prop(base, 'href', TERM.href, tag.href),
                  ...Object.entries(tag.form ?? {}).map(([key, value]) => prop(base, key, FORM_FIELDS[key]!.ns, value)),
                  ...(input.intervalMs !== undefined
                    ? [prop(base, POLLING_FIELD[protocol], POLLING_NS[POLLING_FIELD[protocol]]!, String(input.intervalMs))]
                    : []),
                ]),
              ]),
            ),
          ),
        ]),
      ]) as unknown as SubmodelElement,
    ],
  };
}

/**
 * ConceptDescriptions for the own terms the AID uses — same shape as the golden file
 * (IEC 61360 specification + isCaseOf pointing to the IDTA original). Including these is what makes
 * it pass KOSMO-SME-3 (own IRI requires a CD) from the moment it is created.
 */
const IEC61360 =
  'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0';

function aidConcept(iriBase: string, idShort: string, idtaTerm: string): Record<string, unknown> {
  return {
    modelType: 'ConceptDescription',
    id: `${iriBase}/cd/${idShort}/1/0`,
    idShort,
    embeddedDataSpecifications: [
      {
        dataSpecification: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: IEC61360 }] },
        dataSpecificationContent: {
          modelType: 'DataSpecificationIec61360',
          preferredName: [{ language: 'en', text: idShort }],
          dataType: 'STRING',
          definition: [{ language: 'en', text: idShort }],
        },
      },
    ],
    isCaseOf: [{ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: idtaTerm }] }],
  };
}

/** CDs for every term this AID uses — including tag names (which differ per equipment) */
export function aidConceptDescriptions(input: AidBuildInput): Record<string, unknown>[] {
  const protocol = endpointProtocol(input.endpoint) ?? 'OPCUA';
  const fixed: [string, string][] = [
    [INTERFACE_NAME[protocol], TERM.interface],
    ['EndpointMetadata', TERM.endpointMetadata],
    ['InteractionMetadata', TERM.interactionMetadata],
    ['properties', TERM.properties],
    ['forms', TERM.forms],
    ['base', TERM.base],
    ['contentType', TERM.contentType],
    ['title', TERM.title],
    ['type', TERM.type],
    ['observable', TERM.observable],
    ['href', TERM.href],
    ['key', TERM.key],
    ['unit', TERM.unit],
  ];
  // Terms for the form fields used — once each
  const formKeys = [...new Set(input.tags.flatMap((tag) => Object.keys(tag.form ?? {})))].filter((key) => FORM_FIELDS[key]);
  for (const key of formKeys) fixed.push([key, FORM_FIELDS[key]!.ns]);
  if (input.intervalMs !== undefined) fixed.push([POLLING_FIELD[protocol], POLLING_NS[POLLING_FIELD[protocol]]!]);
  // Security terms once each — `scheme` and `title`-like shared names are skipped when already present
  for (const [name, term] of securityTerms(protocol, input.security)) if (!fixed.some(([known]) => known === name)) fixed.push([name, term]);
  const out = fixed.map(([idShort, term]) => aidConcept(input.iriBase, idShort, term));
  for (const tag of input.tags) {
    out.push(aidConcept(input.iriBase, tag.name, TERM.propertyDefinition));
  }
  return out;
}
