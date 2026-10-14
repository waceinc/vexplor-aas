/**
 * Embedded OPC UA server — spec M6.
 *
 * The diagram in spec III-3 is why this file exists:
 *
 *   Collection client ──write──▶ **OPC UA server** ──subscribe──▶ App 1 · App 2 · App N
 *
 * We already have the left side (M8 collection). The right side was empty —
 * current values can be read via Part 2 REST, but **it only answers when asked.** With several upstream apps,
 * each ends up polling, and nobody knows the moment a value changed. That is why subscriptions are needed.
 *
 * Important: everything is **read-only**. Value sync option A (the file is the source of truth) — if values written via
 *    OPC UA leak into the model, option A breaks at that moment. Package Explorer falls into exactly that trap.
 * Important: off by default. Turning it on **opens a port without authentication** — different in nature from the
 *    HTTP-side token auth, so enabling it must be an explicit decision by the deployer (`OPCUA_SERVER=on`).
 */
import {
  DataType,
  OPCUAServer,
  StatusCodes,
  Variant,
  type Namespace,
  type StatusCode,
  type UAObject,
  type UAVariable,
} from 'node-opcua';
import { tr } from '@aas/core';
import { flattenVariables, type OpcDataType, type PublishNode, type PublishPlan } from './publish.js';

/**
 * Important: a marker that announces, **at the protocol level**, that this server was started by this tool.
 *
 * Why: if this server's address is entered into "Import from equipment", the AAS content we serve
 * comes back as "tags to collect" — a user actually did this, and the UI guidance was creating that path
 * (the export address was shown right next to the collection controls).
 * Comparing address strings cannot prevent it: different hostnames/IPs can be the same server, and conversely
 * the same port can belong to someone else's equipment. **Asking the peer** is the only correct method.
 */
export const PRODUCT_URI = 'urn:kr:aas-authoring-tool:publisher';

export interface AasOpcUaServerOptions {
  /** Default 4840 — the standard OPC UA port */
  port?: number;
  resourcePath?: string;
  /** What to serve. Taken as a function since this package doesn't need to know about the store */
  load: () => Promise<PublishPlan[]>;
  /** Interval (ms) for re-reading the address space. 0 means manual (`refresh()`) only */
  refreshMs?: number;
  /** Host to advertise. Empty means the node-opcua default */
  hostname?: string;
}

export interface ServerStatus {
  running: boolean;
  /** applicationUri of this process — the basis for the "is it ourselves?" check */
  instanceUri?: string;
  endpoint?: string;
  /** Number of files currently being served */
  packages: number;
  /** Number of variable nodes currently being served */
  variables: number;
  lastRefresh?: string;
  lastError?: string;
}

/**
 * One string value -> Variant.
 *
 * Important: a missing value is not an error. Our outputs are Types/Templates, so **empty values are normal**,
 *    and most are empty until collection is attached. So we report `BadWaitingForInitialData` —
 *    upstream apps must be able to tell "not arrived yet" from "the read failed".
 * Important: on a data type mismatch we do not fill in 0. Serving a wrong number is worse than silence.
 */
export function toVariant(
  dataType: OpcDataType,
  raw: string | undefined,
): { variant: Variant; status: StatusCode } {
  const empty = (type: DataType, fallback: unknown): { variant: Variant; status: StatusCode } => ({
    variant: new Variant({ dataType: type, value: fallback }),
    status: StatusCodes.BadWaitingForInitialData,
  });

  if (raw === undefined || raw === '') {
    switch (dataType) {
      case 'Boolean':
        return empty(DataType.Boolean, false);
      case 'Double':
        return empty(DataType.Double, 0);
      case 'Int32':
        return empty(DataType.Int32, 0);
      case 'Int64':
        return empty(DataType.Int64, 0);
      default:
        return empty(DataType.String, '');
    }
  }

  switch (dataType) {
    case 'Boolean': {
      const lowered = raw.trim().toLowerCase();
      if (lowered === 'true' || lowered === '1')
        return { variant: new Variant({ dataType: DataType.Boolean, value: true }), status: StatusCodes.Good };
      if (lowered === 'false' || lowered === '0')
        return { variant: new Variant({ dataType: DataType.Boolean, value: false }), status: StatusCodes.Good };
      return {
        variant: new Variant({ dataType: DataType.Boolean, value: false }),
        status: StatusCodes.BadTypeMismatch,
      };
    }
    case 'Double': {
      const parsed = Number(raw);
      return Number.isFinite(parsed)
        ? { variant: new Variant({ dataType: DataType.Double, value: parsed }), status: StatusCodes.Good }
        : { variant: new Variant({ dataType: DataType.Double, value: 0 }), status: StatusCodes.BadTypeMismatch };
    }
    case 'Int32':
    case 'Int64': {
      const parsed = Number(raw);
      const type = dataType === 'Int32' ? DataType.Int32 : DataType.Int64;
      return Number.isFinite(parsed) && Number.isInteger(parsed)
        ? { variant: new Variant({ dataType: type, value: parsed }), status: StatusCodes.Good }
        : { variant: new Variant({ dataType: type, value: 0 }), status: StatusCodes.BadTypeMismatch };
    }
    default:
      return { variant: new Variant({ dataType: DataType.String, value: raw }), status: StatusCodes.Good };
  }
}

/** Whether the plan's structure changed — distinguished from value-only changes */
function shapeOf(plans: readonly PublishPlan[]): string {
  return plans
    .map((plan) => `${plan.packageId}|${flattenVariables(plan).map((node) => node.nodeId).join(',')}`)
    .join(';');
}

export class AasOpcUaServer {
  private server: OPCUAServer | undefined;
  private root: UAObject | undefined;
  /** nodeId string -> variable handle */
  private readonly variables = new Map<string, UAVariable>();
  private shape = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private status: ServerStatus = { running: false, packages: 0, variables: 0 };
  /** Identity of this process — regenerated on every start */
  private readonly instanceUri = `urn:aas-authoring-tool:${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

  constructor(private readonly options: AasOpcUaServerOptions) {}

  currentStatus(): ServerStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    const port = this.options.port ?? 4840;
    const resourcePath = this.options.resourcePath ?? '/UA/AAS';
    this.server = new OPCUAServer({
      port,
      resourcePath,
      /*
       * Identity is set explicitly. If left empty, node-opcua uses `urn:{hostname}:NodeOPCUA-Server`,
       * which is tied to the hostname and useless for identification.
       *  productUri     — the same across all instances of this tool. Says "a server started by the authoring tool"
       *  applicationUri — this one process only. Says "**exactly myself**"
       * Bonus: giving an applicationUri puts the URI into the self-signed certificate SAN, which also reduces SAN warnings.
       */
      serverInfo: {
        applicationUri: this.instanceUri,
        productUri: PRODUCT_URI,
        // i18n-ignore — OPC UA server name (fixed once at server startup and shown with the same value to every connecting app)
        applicationName: { text: 'VEXPLOR AAS Studio - AAS 내주기' },
      },
      buildInfo: {
        productName: 'VEXPLOR AAS Studio',
        productUri: PRODUCT_URI,
        buildNumber: '1',
        buildDate: new Date(0),
      },
      ...(this.options.hostname ? { alternateHostname: [this.options.hostname] } : {}),
    });
    await this.server.initialize();

    const addressSpace = this.server.engine.addressSpace;
    if (!addressSpace) throw new Error(tr('주소공간을 만들지 못했습니다.'));
    const namespace = addressSpace.getOwnNamespace();
    // Gather everything under one top-level folder — so our nodes don't mix with others'
    this.root = namespace.addObject({
      organizedBy: addressSpace.rootFolder.objects,
      browseName: 'AAS',
      nodeId: 's=AAS',
    });

    await this.server.start();
    this.stopped = false;
    this.status = {
      running: true,
      instanceUri: this.instanceUri,
      endpoint: `opc.tcp://${this.options.hostname ?? '127.0.0.1'}:${port}${resourcePath}`,
      packages: 0,
      variables: 0,
    };

    await this.refresh();
    const interval = this.options.refreshMs ?? 0;
    if (interval > 0) this.schedule(interval);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.variables.clear();
    this.status = { ...this.status, running: false };
    if (this.server) await this.server.shutdown();
    this.server = undefined;
  }

  /**
   * Brings the address space in line with the current state.
   *
   * If only values changed, **nodes are not recreated** — recreating them drops subscriptions,
   * and connected apps would have to resubscribe every time. Rebuild only when the structure changed.
   */
  async refresh(): Promise<void> {
    if (!this.server || !this.root) return;
    try {
      const plans = await this.options.load();
      const shape = shapeOf(plans);
      if (shape !== this.shape) {
        this.rebuild(plans);
        this.shape = shape;
      } else {
        for (const plan of plans) {
          for (const node of flattenVariables(plan)) this.writeValue(node);
        }
      }
      this.status = {
        ...this.status,
        packages: plans.length,
        variables: this.variables.size,
        lastRefresh: new Date().toISOString(),
      };
      delete this.status.lastError;
    } catch (error) {
      // Important: keep the server alive even if a refresh fails — do not drop connected apps
      this.status = {
        ...this.status,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private schedule(interval: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule(interval));
    }, interval);
  }

  /** Rebuilds the structure — deletes existing nodes and creates new ones */
  private rebuild(plans: readonly PublishPlan[]): void {
    const addressSpace = this.server?.engine.addressSpace;
    if (!addressSpace || !this.root) return;
    const namespace = addressSpace.getOwnNamespace();

    for (const child of this.root.getComponents()) addressSpace.deleteNode(child.nodeId);
    this.variables.clear();

    for (const plan of plans) {
      const folder = namespace.addObject({
        componentOf: this.root,
        browseName: plan.name,
        nodeId: `s=${plan.packageId}`,
      });
      this.addChildren(namespace, folder, plan.children);
    }
  }

  private addChildren(
    namespace: Namespace,
    parent: UAObject,
    nodes: readonly PublishNode[],
  ): void {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        const folder = namespace.addObject({
          componentOf: parent,
          browseName: node.name,
          nodeId: `s=${node.nodeId}`,
        }) as UAObject;
        this.addChildren(namespace, folder, node.children);
        continue;
      }
      const variable = namespace.addVariable({
        componentOf: parent,
        browseName: node.name,
        nodeId: `s=${node.nodeId}`,
        dataType: node.dataType ?? 'String',
        // Important: read-only — enforces option A at the protocol level
        accessLevel: 'CurrentRead',
        userAccessLevel: 'CurrentRead',
        minimumSamplingInterval: 0,
      }) as UAVariable;
      this.variables.set(node.nodeId, variable);
      this.writeValue(node);
    }
  }

  /** Pushes one value — fires here if a subscription is active */
  private writeValue(node: PublishNode): void {
    const variable = this.variables.get(node.nodeId);
    if (!variable) return;
    const { variant, status } = toVariant(node.dataType ?? 'String', node.value);
    variable.setValueFromSource(variant, status);
  }
}
