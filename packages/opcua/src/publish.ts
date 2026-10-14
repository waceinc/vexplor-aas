/**
 * Publish engine — spec M7. **AAS hierarchy -> OPC UA node tree**.
 *
 * Why this must exist (spec II-3):
 *   "If all BaSyx does is import AASX and fill an OPC UA server's values,
 *     it is simpler for **the authoring tool itself to become the OPC UA server** than to keep an intermediary"
 * In other words, we scrape values from equipment (M8) and become **a relay that serves those values back out**.
 * Current values can also be read via REST (Part 2), but that only answers when asked — for N upstream apps to receive
 * them via **subscriptions**, an OPC UA server is required (spec III-3 "subscription-based simultaneous delivery to N apps").
 *
 * Important: this file does not call node-opcua. **It only builds a plan** — so it can be tested without a server.
 *    Materialization is done by server.ts (M6).
 *
 * Design decisions — do not reverse:
 *  ① **NodeIds use the same path as the Part 2 idShortPath.** If the same element has different names
 *     in REST and OPC UA, they cannot be cross-checked in the field.
 *  ② **Everything is read-only.** Value sync option A (the file is the source of truth) — if values changed via
 *     OPC UA leak into the model, option A breaks at that moment. Package Explorer falls into exactly that trap (§2-2).
 *  ③ **Children without an idShort are not dropped.** SML children may be anonymous (AASd-120) —
 *     dropping them for lacking a name makes the tree diverge from the original. Referenced as `[n]` per the spec.
 */
import type { Environment, Submodel, SubmodelElement } from '@aas/core';

/** OPC UA data types we use — the model's xs:* types are narrowed to these five */
export type OpcDataType = 'Boolean' | 'Double' | 'Int32' | 'Int64' | 'String';

export interface PublishNode {
  /** browseName. Unique among siblings */
  name: string;
  /** ns=1;s=<this value> — the same path as the Part 2 idShortPath */
  nodeId: string;
  kind: 'folder' | 'variable';
  /** Only for variables */
  dataType?: OpcDataType;
  /** AAS holds values as strings. Type conversion is done by the server */
  value?: string;
  /** Which AAS element it came from — for human cross-checking */
  modelType?: string;
  children: PublishNode[];
}

export interface PublishPlan {
  packageId: string;
  /** Folder name — the equipment name */
  name: string;
  children: PublishNode[];
  /** Number of variables to be materialized — used by logs and tests */
  variables: number;
}

/**
 * xs:* -> OPC UA data type.
 *
 * Important: unknown types fall back to String. Guessing a number and then failing to parse
 *    **silently loses the value** — better to show it, even as a string.
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

/** Kinds that carry a value out. Container elements become folders */
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

/** Picks the single value string to export from an element */
function valueOf(node: SubmodelElement): string | undefined {
  const record = node as unknown as Record<string, unknown>;
  if (node.modelType === 'MultiLanguageProperty') {
    // Use the first language. The language concept is not forced onto the OPC UA side
    const list = record['value'];
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const first = list[0] as { text?: unknown };
    return typeof first?.text === 'string' ? first.text : undefined;
  }
  if (node.modelType === 'Range') {
    // A range is not a single value — join it into a human-readable form
    const min = record['min'];
    const max = record['max'];
    if (min === undefined && max === undefined) return undefined;
    return `${String(min ?? '')}..${String(max ?? '')}`;
  }
  const value = record['value'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Keeps sibling names from colliding.
 *
 * Important: in OPC UA, duplicate browseNames under the same parent **get overwritten and lost.**
 *    Defective AAS files with duplicate idShorts really exist (measured in KOSMO data) —
 *    nodes must not disappear even when such a file comes in.
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
    // Per the spec, SML children are referenced by index (they may be anonymous) — same rule as model.ts
    const name = uniqueName(taken, node.idShort ?? `[${index}]`);
    // Important: path segments also use **the de-duplicated name**. Duplicate idShorts are a real defect
    //    (KOSMO-CD-5); left as-is, NodeIds collide and an entire node disappears.
    //    In well-formed files name === idShort, so it does not differ from the Part 2 idShortPath by a single character.
    const segment = parentIsList ? `[${index}]` : name;
    // Important: no leading '.' at the top level
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
      // Range and MLP have no xs data type (or it means something else), so they are emitted as strings
      dataType:
        node.modelType === 'Property' ? opcTypeOf(typeof valueType === 'string' ? valueType : undefined) : 'String',
      ...(value === undefined ? {} : { value }),
      modelType: node.modelType,
      children: [],
    };
  });
}

/** One submodel -> one folder */
export function planForSubmodel(
  submodel: Submodel,
  packageId: string,
  counter: { variables: number },
  taken: Set<string>,
): PublishNode {
  // Important: some submodels have no idShort. Reference them by id so they do not vanish from the tree
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
 * One file -> a node plan.
 *
 * To include values, pass an Environment with collected values overlaid via `overlayEnvironment` —
 * this function only carries over **what is written in the model**; it does not read the time series separately.
 * (picking values in two places would make REST and OPC UA report different values)
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
  // For the name, the AAS idShort is closest to human language. Falls back to the file name
  const shell = environment.assetAdministrationShells?.[0];
  return {
    packageId: options.packageId,
    name: shell?.idShort ?? options.name ?? options.packageId,
    children,
    variables: counter.variables,
  };
}

/** Flattens all variable nodes in the plan — used when the server updates values */
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
