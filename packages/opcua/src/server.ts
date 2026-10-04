/**
 * OPC UA 서버 내장 — 기획서 M6.
 *
 * 기획서 Ⅲ-3의 그림이 이 파일이 있는 이유다:
 *
 *   수집 클라이언트 ──write──▶ **OPC UA 서버** ──subscribe──▶ App 1 · App 2 · App N
 *
 * 우리는 이미 왼쪽(M8 수집)을 갖고 있다. 오른쪽이 비어 있었다 —
 * Part 2 REST로 현재값을 읽을 수는 있지만 **물어봐야 답한다.** 상위 앱이 여러 개면
 * 저마다 폴링하게 되고, 값이 바뀐 순간을 아무도 모른다. 구독이 필요한 이유다.
 *
 * 🔴 전부 **읽기 전용**이다. 값 동기화 A안(파일이 원본) — OPC UA로 값을 써서 모델에
 *    스며들면 그 순간 A안이 깨진다. Package Explorer가 정확히 그 함정에 빠져 있다.
 * 🔴 기본은 꺼져 있다. 켜는 순간 **인증 없는 포트가 하나 열린다** — HTTP 쪽 토큰 인증과
 *    성격이 다르므로, 켜는 것은 배포자가 명시적으로 정해야 한다(`OPCUA_SERVER=on`).
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
import { flattenVariables, type OpcDataType, type PublishNode, type PublishPlan } from './publish.js';

/**
 * 🔴 이 도구가 띄운 서버임을 **프로토콜 수준에서** 알리는 표식.
 *
 * 왜 필요한가: 「설비에서 불러오기」에 이 서버의 주소를 넣으면 우리가 내준 AAS 내용이
 * 「수집할 태그」로 되돌아온다 — 실제로 사용자가 그렇게 했고, 화면 안내가 그 동선을
 * 만들고 있었다(내보내기 주소가 수집 조작부 바로 옆에 떠 있었다).
 * 주소 문자열 비교로는 못 막는다: 호스트명·IP가 달라도 같은 서버이고, 반대로
 * 같은 포트라도 남의 설비일 수 있다. **상대에게 물어보는 것**이 유일하게 맞는 방법이다.
 */
export const PRODUCT_URI = 'urn:kr:aas-authoring-tool:publisher';

export interface AasOpcUaServerOptions {
  /** 기본 4840 — OPC UA 표준 포트 */
  port?: number;
  resourcePath?: string;
  /** 무엇을 내줄지. 저장소를 이 패키지가 알 필요는 없어서 함수로 받는다 */
  load: () => Promise<PublishPlan[]>;
  /** 주소공간을 다시 읽는 주기(ms). 0이면 수동(`refresh()`)만 */
  refreshMs?: number;
  /** 광고할 호스트. 비우면 node-opcua 기본 */
  hostname?: string;
}

export interface ServerStatus {
  running: boolean;
  /** 이 프로세스의 applicationUri — 「자기 자신인가」 판정의 기준 */
  instanceUri?: string;
  endpoint?: string;
  /** 지금 내주고 있는 파일 수 */
  packages: number;
  /** 지금 내주고 있는 변수 노드 수 */
  variables: number;
  lastRefresh?: string;
  lastError?: string;
}

/**
 * 문자열 값 하나를 Variant로.
 *
 * 🔴 값이 없는 것은 오류가 아니다. 우리 산출물은 Type/Template이라 **빈 값이 정상**이고,
 *    수집이 붙기 전에는 대부분 비어 있다. 그래서 `BadWaitingForInitialData`로 낸다 —
 *    "아직 안 들어왔다"와 "읽다 실패했다"를 상위 앱이 구분할 수 있어야 한다.
 * 🔴 자료형이 안 맞으면 0으로 채우지 않는다. 잘못된 숫자를 내주는 것이 침묵보다 나쁘다.
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

/** 계획의 뼈대가 바뀌었는지 — 값만 바뀐 것과 구분한다 */
function shapeOf(plans: readonly PublishPlan[]): string {
  return plans
    .map((plan) => `${plan.packageId}|${flattenVariables(plan).map((node) => node.nodeId).join(',')}`)
    .join(';');
}

export class AasOpcUaServer {
  private server: OPCUAServer | undefined;
  private root: UAObject | undefined;
  /** nodeId 문자열 → 변수 핸들 */
  private readonly variables = new Map<string, UAVariable>();
  private shape = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private status: ServerStatus = { running: false, packages: 0, variables: 0 };
  /** 이 프로세스의 신원 — 기동마다 새로 만든다 */
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
       * 신원을 명시한다. 비워 두면 node-opcua가 `urn:{hostname}:NodeOPCUA-Server`를 쓰는데,
       * 그건 호스트명에 매여 있어 판별에 못 쓴다.
       *  productUri     — 이 도구 전부에서 같다. "저작도구가 띄운 서버"임을 말한다
       *  applicationUri — 이 프로세스 하나. "**바로 나 자신**"임을 말한다
       * 덤: applicationUri를 주면 자체서명 인증서 SAN에 URI가 들어가 SAN 경고도 줄어든다.
       */
      serverInfo: {
        applicationUri: this.instanceUri,
        productUri: PRODUCT_URI,
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
    if (!addressSpace) throw new Error('주소공간을 만들지 못했습니다.');
    const namespace = addressSpace.getOwnNamespace();
    // 최상위 폴더 하나로 모은다 — 우리 것이 남의 노드와 섞이지 않게
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
   * 주소공간을 지금 상태에 맞춘다.
   *
   * 값만 바뀌었으면 **노드를 다시 만들지 않는다** — 다시 만들면 구독이 끊어지고,
   * 붙어 있던 앱들이 매번 재구독해야 한다. 뼈대가 바뀌었을 때만 다시 세운다.
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
      // 🔴 새로 고침이 실패해도 서버는 살려 둔다 — 붙어 있는 앱을 떨구지 않는다
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

  /** 뼈대를 다시 세운다 — 기존 노드는 지우고 새로 만든다 */
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
        // 🔴 읽기 전용 — A안을 프로토콜 수준에서 강제한다
        accessLevel: 'CurrentRead',
        userAccessLevel: 'CurrentRead',
        minimumSamplingInterval: 0,
      }) as UAVariable;
      this.variables.set(node.nodeId, variable);
      this.writeValue(node);
    }
  }

  /** 값 하나를 밀어 넣는다 — 구독이 걸려 있으면 여기서 발화한다 */
  private writeValue(node: PublishNode): void {
    const variable = this.variables.get(node.nodeId);
    if (!variable) return;
    const { variant, status } = toVariant(node.dataType ?? 'String', node.value);
    variable.setValueFromSource(variant, status);
  }
}
