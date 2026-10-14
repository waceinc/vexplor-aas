/**
 * Built-in virtual PLC — an OPC UA server started inside the tool. Important: this is a **simulation**.
 *
 * The "How to reproduce" section of the reference bundle README must be followable by evaluators. But evaluators only have
 * the installed build, so they could not run `node scripts/plc-simulator.mjs` (verified 2026-09-30 — the installed build has no scripts/).
 * So the virtual PLC lives in the server. One "Connect to virtual PLC" per equipment file brings up the tags and sets up the collection connection.
 *
 * Tags come from simulationPlan (the equipment AASX's OperationalData names as-is) — the same rule as the script version.
 * One object per equipment is attached to a single server. Attaching the same equipment twice returns the first one unchanged.
 */
import { DataType, DataValue, OPCUAServer, StatusCodes, Variant } from 'node-opcua';
import { simulationPlan, type SimDataType } from './simulate.js';

export const SIMULATOR_RESOURCE_PATH = '/UA/Simulator';
// i18n-ignore — collection connection name written into the AAS file (data) — evidence uses this value to tell simulation apart
export const SIMULATOR_TITLE = '가상 PLC (시뮬레이션)';

const OPC_TYPE: Record<SimDataType, DataType> = {
  Double: DataType.Double,
  Int32: DataType.Int32,
  Boolean: DataType.Boolean,
  String: DataType.String,
};

/** AID tag type (W3C WoT) — the shape accepted when creating a collection connection */
const AID_TYPE: Record<SimDataType, string> = { Double: 'float', Int32: 'integer', Boolean: 'boolean', String: 'string' };

export interface SimulatedMachine {
  machine: string;
  endpoint: string;
  /** Tags to put into the collection connection (AID) as-is — on duplicate names only the first is kept (AID names must be unique) */
  tags: { name: string; href: string; type: string }[];
}

export interface SimulatorOptions {
  port?: number;
  /** Host used in the endpoint URL. Default 127.0.0.1 — meant for reproducing on your own PC */
  host?: string;
}

export class SimulatorServer {
  private server: OPCUAServer | undefined;
  private starting: Promise<OPCUAServer> | undefined;
  private readonly started = Date.now();
  private readonly attached = new Map<string, SimulatedMachine>();
  readonly port: number;
  readonly endpoint: string;

  constructor(options: SimulatorOptions = {}) {
    this.port = options.port ?? 14850;
    this.endpoint = `opc.tcp://${options.host ?? '127.0.0.1'}:${this.port}${SIMULATOR_RESOURCE_PATH}`;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  machines(): string[] {
    return [...this.attached.keys()];
  }

  private async ensure(): Promise<OPCUAServer> {
    if (this.server) return this.server;
    this.starting ??= (async () => {
      const server = new OPCUAServer({
        port: this.port,
        resourcePath: SIMULATOR_RESOURCE_PATH,
        // Identity distinct from the exposure server (instanceUri) — so it does not get mixed up with the "browsing itself" guard
        serverInfo: { applicationUri: 'urn:wace:aas-studio:simulator' },
        buildInfo: { productName: SIMULATOR_TITLE, buildNumber: '1', buildDate: new Date(0) },
      });
      await server.initialize();
      await server.start();
      this.server = server;
      return server;
    })();
    try {
      return await this.starting;
    } catch (error) {
      this.starting = undefined; // If the port was blocked, retry on the next attempt
      throw error;
    }
  }

  /** Attaches one piece of equipment — returns it unchanged if already attached */
  async attach(environment: Parameters<typeof simulationPlan>[0]): Promise<SimulatedMachine> {
    const plan = simulationPlan(environment);
    const already = this.attached.get(plan.name);
    if (already) return already;

    const server = await this.ensure();
    const addressSpace = server.engine.addressSpace!;
    const namespace = addressSpace.getOwnNamespace();
    const object = namespace.addObject({ organizedBy: addressSpace.rootFolder.objects, browseName: plan.name });
    const seconds = (): number => (Date.now() - this.started) / 1000;
    const seen = new Set<string>();
    const tags: SimulatedMachine['tags'] = [];

    for (const tag of plan.tags) {
      namespace.addVariable({
        componentOf: object,
        browseName: tag.name,
        nodeId: `s=${tag.nodeId}`,
        dataType: tag.dataType,
        minimumSamplingInterval: 500,
        value: {
          // Important: stamp the value with the current time on every read — otherwise unchanging values go out carrying their first timestamp
          timestamped_get: () =>
            new DataValue({
              value: new Variant({ dataType: OPC_TYPE[tag.dataType], value: tag.valueAt(seconds()) }),
              statusCode: StatusCodes.Good,
              sourceTimestamp: new Date(),
              serverTimestamp: new Date(),
            }),
        },
      });
      if (seen.has(tag.name)) continue;
      seen.add(tag.name);
      tags.push({ name: tag.name, href: `ns=${namespace.index};s=${tag.nodeId}`, type: AID_TYPE[tag.dataType] });
    }

    const result: SimulatedMachine = { machine: plan.name, endpoint: this.endpoint, tags };
    this.attached.set(plan.name, result);
    return result;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    this.attached.clear();
    if (server) await server.shutdown();
  }
}
