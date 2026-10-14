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

export type AidProtocol = 'OPCUA' | 'HTTP' | 'MODBUS' | 'MQTT' | 'UNKNOWN';

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

export interface AidInterface {
  /** Element idShort (e.g. InterfaceTemplateForOPCUA) */
  name: string;
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

/** Derives the protocol from the name. AID uses the InterfaceTemplateFor<PROTO> convention */
export function protocolOf(name: string, base?: string): AidProtocol {
  const upper = name.toUpperCase();
  if (upper.includes('OPCUA') || upper.includes('OPC_UA') || base?.startsWith('opc.tcp')) return 'OPCUA';
  if (upper.includes('MODBUS') || base?.startsWith('modbus')) return 'MODBUS';
  if (upper.includes('MQTT') || base?.startsWith('mqtt')) return 'MQTT';
  if (upper.includes('HTTP') || base?.startsWith('http')) return 'HTTP';
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

    const descriptor: AidInterface = { name, protocol: protocolOf(name, base), properties };
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
