/**
 * 내장 가상 PLC — 도구 안에서 켜는 OPC UA 서버. 🔴 **시뮬레이션**이다.
 *
 * 레퍼런스 번들 README의 「재현 방법」은 평가자가 따라 할 수 있어야 한다. 그런데 평가자에겐 설치판뿐이라
 * `node scripts/plc-simulator.mjs`를 돌릴 수 없었다(2026-09-30 검증 — 설치판에 scripts/가 없다).
 * 그래서 가상 PLC를 서버에 넣는다. 설비 파일마다 「가상 PLC로 연결」 한 번이면 태그가 서고 수집 연결까지 된다.
 *
 * 태그는 simulationPlan(설비 AASX의 OperationalData 이름 그대로) — 스크립트판과 같은 규칙이다.
 * 한 서버에 설비마다 오브젝트 하나를 붙인다. 같은 설비를 두 번 붙이면 처음 것을 그대로 돌려준다.
 */
import { DataType, DataValue, OPCUAServer, StatusCodes, Variant } from 'node-opcua';
import { simulationPlan, type SimDataType } from './simulate.js';

export const SIMULATOR_RESOURCE_PATH = '/UA/Simulator';
export const SIMULATOR_TITLE = '가상 PLC (시뮬레이션)';

const OPC_TYPE: Record<SimDataType, DataType> = {
  Double: DataType.Double,
  Int32: DataType.Int32,
  Boolean: DataType.Boolean,
  String: DataType.String,
};

/** AID 태그 타입(W3C WoT) — 수집 연결 만들기가 받는 꼴 */
const AID_TYPE: Record<SimDataType, string> = { Double: 'float', Int32: 'integer', Boolean: 'boolean', String: 'string' };

export interface SimulatedMachine {
  machine: string;
  endpoint: string;
  /** 수집 연결(AID)에 그대로 넣을 태그 — 이름이 겹치면 첫 자리만(AID 이름은 고유해야 한다) */
  tags: { name: string; href: string; type: string }[];
}

export interface SimulatorOptions {
  port?: number;
  /** 접속 주소에 쓸 호스트. 기본 127.0.0.1 — 자기 PC에서 재현하는 용도다 */
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
        // 노출용 서버(instanceUri)와 다른 신원 — 「자기 자신 훑기」 방지와 섞이지 않게
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
      this.starting = undefined; // 포트가 막혔던 경우 다음 시도에서 다시
      throw error;
    }
  }

  /** 설비 하나를 붙인다 — 이미 붙어 있으면 그대로 돌려준다 */
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
          // 🔴 값의 시각을 읽을 때마다 지금으로 — 안 그러면 안 바뀌는 값이 처음 시각을 달고 나간다
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
