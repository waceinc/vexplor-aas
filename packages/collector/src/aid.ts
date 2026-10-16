/**
 * AID (Asset Interface Description) submodel parsing — the starting point of spec M8.
 *
 * "Which Property should the PLC's D100 value go into?" is not defined by any standard (AAS_OPC UA.md §7-1).
 * That makes a custom mapping table tempting, but **a custom submodel is not allowed when IDTA
 * has an equivalent template** (KTL modeling rule). Research showed AID is exactly that template,
 * and **AID 1.1 supports OPC UA** (IDTA-02017, based on the W3C WoT Thing Description).
 * → We do not build a custom mapping; we **read the AID inside the AAS.**
 *
 * Structure (measured from the IDTA-02017-1-0 template)
 *   AssetInterfacesDescription (Submodel)
 *   └ InterfaceTemplateFor<PROTO> (SMC)
 *      ├ EndpointMetadata (SMC) — base (endpoint address) · contentType · security
 *      └ InteractionMetadata (SMC)
 *         └ properties (SMC)
 *            └ <name> (SMC) — key · type · unit · observable …
 *               └ forms (SMC) — href (address) · contentType · protocol-specific fields
 *
 * Important: the OPC UA-specific fields of AID 1.1 (term names) must be confirmed against the published
 * release. So the remaining forms fields are **kept as-is regardless of name** (formFields) — once the
 * spec is finalized, read them from there.
 */
import type { Environment, Submodel, SubmodelElement } from '@aas/core';
import { tr } from '@aas/core';

/** semanticId of the AID submodel (the version segment is matched loosely) */
export const AID_SEMANTIC_ID_PREFIX = 'https://admin-shell.io/idta/AssetInterfacesDescription/';

/** BACNET is recognised (AID 1.1) but not collected yet — callers treat it like UNKNOWN */
export type AidProtocol = 'OPCUA' | 'HTTP' | 'MODBUS' | 'MQTT' | 'BACNET' | 'UNKNOWN';

/** AID 1.1 interface supplementalSemanticIds (IDTA-02017 1.1 Table 3) */
const PROTOCOL_IRIS: Record<string, AidProtocol> = {
  'http://www.w3.org/2011/modbus': 'MODBUS',
  'http://www.w3.org/2011/mqtt': 'MQTT',
  'http://www.w3.org/2011/http': 'HTTP',
  'http://www.w3.org/2022/bacnet': 'BACNET',
  'http://opcfoundation.org/UA/WoT-Binding/': 'OPCUA',
};

export interface AidProperty {
  /** Name used for display and storage (the element's idShort) */
  name: string;
  /** The AID key — asset-side identifier */
  key?: string;
  /** float · integer · string · boolean … (WoT type) */
  type?: string;
  unit?: string;
  observable: boolean;
  /** Address to read. NodeId for OPC UA, path for HTTP */
  href?: string;
  /** Remaining fields inside forms — protocol-specific (htv_*, modv_*, opc_* …) */
  formFields: Record<string, string>;
}

/** OPC UA security an interface states (IDTA-02017 1.1 §2.27.7 – 2.27.8) — what the reader needs, never a secret */
export interface AidSecurity {
  mode?: 'None' | 'Sign' | 'SignAndEncrypt';
  policy?: string;
  userIdentityToken?: 'Anonymous' | 'UserName' | 'Certificate' | 'IssuedToken';
}

export interface AidInterface {
  /** Element idShort (e.g. InterfaceTemplateForOPCUA) */
  name: string;
  /** From EndpointMetadata `security` / `securityDefinitions` (AID 1.1). Absent when the interface states none */
  security?: AidSecurity;
  title?: string;
  protocol: AidProtocol;
  /** Endpoint address. opc.tcp://… for OPC UA */
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

const UAV = 'http://opcfoundation.org/UA/WoT-Binding/';
const MODES = new Set(['None', 'Sign', 'SignAndEncrypt']);
const TOKENS = new Set(['Anonymous', 'UserName', 'Certificate', 'IssuedToken']);

function semanticOf(node: SubmodelElement | undefined): string | undefined {
  return node?.semanticId?.keys?.[0]?.value;
}

/** The scheme idShorts a `security` or `allOf` list points at — the last key of each reference */
function referencedNames(node: SubmodelElement | undefined): string[] {
  return children(node).flatMap((entry) => {
    const keys = (entry as { value?: { keys?: { value?: string }[] } }).value?.keys;
    const last = keys?.[keys.length - 1]?.value;
    return last ? [last] : [];
  });
}

/** One OPC UA term of a scheme: by semanticId, else by the specification's idShort (`uav_<term>`) */
function termOf(scheme: SubmodelElement, term: string): string | undefined {
  const node = children(scheme).find((c) => semanticOf(c) === `${UAV}${term}`) ?? child(scheme, `uav_${term}`);
  return text(node);
}

/**
 * The OPC UA security an interface states. Only schemes named by EndpointMetadata `security` apply (followed through
 * `allOf` of combo schemes, loops cut); a scheme counts as channel or authentication by semanticId, else by its idShort.
 * Values outside the binding's lists are dropped rather than guessed.
 */
export function securityOf(endpoint: SubmodelElement | undefined): AidSecurity | undefined {
  const definitions = new Map(children(child(endpoint, 'securityDefinitions')).map((scheme) => [scheme.idShort ?? '', scheme] as const));
  const out: AidSecurity = {};
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const scheme = definitions.get(name);
    if (!scheme) return;
    const semantic = semanticOf(scheme);
    if (semantic === `${UAV}OPCUASecurityChannelScheme` || (!semantic && name.startsWith('opcua_channel'))) {
      const mode = termOf(scheme, 'securityMode');
      if (mode && MODES.has(mode)) out.mode = mode as AidSecurity['mode'];
      const policy = termOf(scheme, 'securityPolicy');
      if (policy) out.policy = policy;
    } else if (semantic === `${UAV}OPCUASecurityAuthenticationScheme` || (!semantic && name.startsWith('opcua_authentication'))) {
      const token = termOf(scheme, 'userIdentityToken');
      if (token && TOKENS.has(token)) out.userIdentityToken = token as AidSecurity['userIdentityToken'];
    }
    for (const next of referencedNames(child(scheme, 'allOf'))) visit(next);
  };
  for (const name of referencedNames(child(endpoint, 'security'))) visit(name);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The protocol of an interface (plan gap 3). AID 1.1 states it by the interface's supplementalSemanticId; without one,
 * the endpoint scheme decides, and only then the idShort — a naming convention ("InterfaceTemplateFor<PROTO>") that
 * "Interface00" follows just as validly.
 */
export function protocolOf(name: string, base?: string, supplementalSemanticIds?: readonly string[]): AidProtocol {
  for (const iri of supplementalSemanticIds ?? []) {
    // A trailing slash written or left out is the same IRI
    const stated = PROTOCOL_IRIS[iri] ?? PROTOCOL_IRIS[`${iri}/`] ?? PROTOCOL_IRIS[iri.replace(/\/$/, '')];
    if (stated) return stated;
  }
  const scheme = base?.toLowerCase() ?? '';
  if (scheme.startsWith('opc.tcp')) return 'OPCUA';
  if (scheme.startsWith('modbus')) return 'MODBUS';
  if (scheme.startsWith('mqtt')) return 'MQTT';
  if (scheme.startsWith('http')) return 'HTTP';
  if (scheme.startsWith('bacnet')) return 'BACNET';
  const upper = name.toUpperCase();
  if (upper.includes('OPCUA') || upper.includes('OPC_UA')) return 'OPCUA';
  if (upper.includes('MODBUS')) return 'MODBUS';
  if (upper.includes('MQTT')) return 'MQTT';
  if (upper.includes('HTTP')) return 'HTTP';
  if (upper.includes('BACNET')) return 'BACNET';
  return 'UNKNOWN';
}

/** Finds AID submodels in an Environment. Matches by semanticId, then falls back to idShort */
export function findAidSubmodels(environment: Environment): Submodel[] {
  return (environment.submodels ?? []).filter((submodel) => {
    const semantic = submodel.semanticId?.keys?.[0]?.value ?? '';
    if (semantic.startsWith(AID_SEMANTIC_ID_PREFIX)) return true;
    return submodel.idShort === 'AssetInterfacesDescription';
  });
}

/** Flattens one AID submodel into a list of interfaces */
export function parseAidSubmodel(submodel: Submodel): AidInterface[] {
  const out: AidInterface[] = [];

  for (const node of submodel.submodelElements ?? []) {
    if (node.modelType !== 'SubmodelElementCollection') continue;
    const endpoint = child(node, 'EndpointMetadata');
    const interaction = child(node, 'InteractionMetadata');
    // If neither is present it is not an interface (e.g. a collection holding only a title)
    if (!endpoint && !interaction) continue;

    const base = text(child(endpoint, 'base'));
    const name = node.idShort ?? tr('(이름 없음)');
    const properties: AidProperty[] = [];

    for (const property of children(child(interaction, 'properties'))) {
      const forms = child(property, 'forms');
      const formFields: Record<string, string> = {};
      for (const field of children(forms)) {
        const value = text(field);
        if (field.idShort && value && field.idShort !== 'href') formFields[field.idShort] = value;
      }

      const entry: AidProperty = {
        name: property.idShort ?? tr('(이름 없음)'),
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

    const supplemental = ((node as { supplementalSemanticIds?: { keys?: { value?: string }[] }[] }).supplementalSemanticIds ?? []).flatMap((reference) =>
      (reference.keys ?? []).flatMap((key) => (key.value ? [key.value] : [])),
    );
    const descriptor: AidInterface = { name, protocol: protocolOf(name, base, supplemental), properties };
    const security = securityOf(endpoint);
    if (security) descriptor.security = security;
    const title = text(child(node, 'title'));
    if (title) descriptor.title = title;
    if (base) descriptor.base = base;
    out.push(descriptor);
  }

  return out;
}

/** Collects interfaces from the whole Environment */
export function parseAid(environment: Environment): AidInterface[] {
  return findAidSubmodels(environment).flatMap((submodel) => parseAidSubmodel(submodel));
}

/** Only properties that can actually be read — without an address nothing can be collected */
export function readableProperties(descriptor: AidInterface): AidProperty[] {
  return descriptor.properties.filter((property) => property.href !== undefined);
}
