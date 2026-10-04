/**
 * 설비를 훑어 **수집할 수 있는 태그 목록**을 가져온다.
 *
 * 왜 필요한가: 지금까지 NodeId(`ns=1;s=Machine.MotorSpeed`)를 사람이 손으로 쳤다.
 * 설비 하나에 태그가 수십~수백 개면 현실성이 없고, 오타 하나면 그 태그만 조용히 안 들어온다
 * — 값이 비는 이유를 나중에 찾기가 가장 어렵다. 붙어서 읽어 오면 둘 다 없어진다.
 *
 * 🔴 **읽기만 한다.** 설비에 쓰지 않는다.
 * 🔴 상한을 둔다. 현장 서버에는 노드가 수만 개인 경우가 있고, 다 훑으면 화면이 죽는다.
 *    끊긴 자리를 `truncated`로 알린다 — 조용히 잘라 내면 "왜 그 태그가 없지"가 된다.
 */
import { PRODUCT_URI } from './server.js';
import {
  AttributeIds,
  BrowseDirection,
  NodeClass,
  OPCUAClient,
  StatusCodes,
  type ClientSession,
} from 'node-opcua';

export interface BrowsedNode {
  /** 그대로 AID의 href가 된다 */
  nodeId: string;
  /** browseName — 태그 이름 후보 */
  name: string;
  /** 어디에 있는 것인지 사람이 알아보게: Machine > Motor > Speed */
  path: string;
  /** AID의 type 칸에 그대로 넣을 수 있는 값 */
  type: 'float' | 'integer' | 'boolean' | 'string';
  /** 지금 값 — 붙자마자 "이게 그 태그가 맞나"를 눈으로 확인하는 근거 */
  value?: string;
  /** 읽히지 않는 태그도 목록에는 남긴다. 왜 안 되는지가 정보다 */
  error?: string;
}

export interface BrowseResult {
  endpoint: string;
  nodes: BrowsedNode[];
  /** 상한에 걸려 멈췄는가 */
  truncated: boolean;
}

/** 상대가 누구인지 — 자기 자신을 훑는 사고를 막는 근거 */
export interface DeviceIdentity {
  applicationUri?: string;
  productUri?: string;
  applicationName?: string;
}

export class SelfBrowseError extends Error {
  constructor(
    message: string,
    /** 'self' = 바로 이 프로세스 · 'sibling' = 다른 대의 같은 도구 */
    readonly kind: 'self' | 'sibling',
  ) {
    super(message);
    this.name = 'SelfBrowseError';
  }
}

export interface BrowseOptions {
  endpoint: string;
  /**
   * 이 프로세스가 띄운 OPC UA 서버의 applicationUri.
   * 주면 **자기 자신을 훑는 것을 막는다** — 우리가 내준 AAS가 「수집할 태그」로 되돌아오는 사고.
   */
  selfUri?: string;
  /** 기본 5000 */
  connectTimeoutMs?: number;
  /** 몇 단까지 들어갈지. 기본 6 */
  maxDepth?: number;
  /** 몇 개까지 모을지. 기본 500 */
  maxNodes?: number;
}

/**
 * 표준 자료형의 NodeId 번호 → AID의 네 갈래.
 *
 * 🔴 DataType 속성은 **이름이 아니라 NodeId로 온다**(`ns=0;i=11`). 이름인 줄 알고 문자열을
 *    뒤지면 전부 string으로 떨어진다 — 실측으로 걸렸다(정수 태그가 죄다 string이 됐다).
 *    번호는 OPC UA Part 6 부속서 A의 고정값이다.
 */
const BUILTIN_TYPE: Record<number, BrowsedNode['type']> = {
  1: 'boolean',
  2: 'integer', 3: 'integer', 4: 'integer', 5: 'integer',
  6: 'integer', 7: 'integer', 8: 'integer', 9: 'integer',
  10: 'float', 11: 'float',
  12: 'string', 13: 'string',
};

/** OPC UA 자료형(NodeId 또는 이름) → AID가 쓰는 네 갈래 */
export function aidTypeOf(dataType: string | undefined): BrowsedNode['type'] {
  const text = (dataType ?? '').toLowerCase();
  // ① 표준 자료형이면 번호로 정확히 안다
  const standard = /^ns=0;i=(\d+)$/.exec(text) ?? /^i=(\d+)$/.exec(text);
  if (standard) {
    const mapped = BUILTIN_TYPE[Number(standard[1])];
    if (mapped) return mapped;
  }
  // ② 이름으로 온 경우(벤더 자료형·시험) — 있는 그대로 읽어 본다
  if (text.includes('bool')) return 'boolean';
  if (text.includes('double') || text.includes('float') || text.includes('decimal')) return 'float';
  if (text.includes('int') || text.includes('byte')) return 'integer';
  return 'string';
}

/** 값 하나를 사람이 읽는 문자열로. 배열·구조체는 굳이 펼치지 않는다 */
export function showValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return `[${value.length}개]`;
  if (typeof value === 'object') return '(구조체)';
  return String(value);
}

/**
 * 표준 노드는 건너뛴다.
 * 🔴 ns=0은 OPC UA가 스스로 갖고 있는 서버 정보(Server_ServerStatus 등)라
 *    설비 값이 아니다. 이걸 섞어 보여 주면 사람이 진짜 태그를 못 찾는다.
 */
function isVendorNode(nodeId: string): boolean {
  return !nodeId.startsWith('ns=0;') && nodeId !== 'i=85';
}

/** 상대 서버의 신원. 못 읽어도 훑기를 막지 않는다 — 모르는 것과 아닌 것은 다르다 */
export async function describeServer(client: OPCUAClient): Promise<DeviceIdentity> {
  try {
    const endpoints = await client.getEndpoints();
    const server = endpoints[0]?.server;
    if (!server) return {};
    return {
      ...(server.applicationUri ? { applicationUri: server.applicationUri } : {}),
      ...(server.productUri ? { productUri: server.productUri } : {}),
      ...(server.applicationName?.text ? { applicationName: server.applicationName.text } : {}),
    };
  } catch {
    return {};
  }
}

export async function browseDevice(options: BrowseOptions): Promise<BrowseResult> {
  const timeout = options.connectTimeoutMs ?? 5000;
  const maxDepth = options.maxDepth ?? 6;
  const maxNodes = options.maxNodes ?? 500;

  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 0, initialDelay: 200, maxDelay: 1000 },
    requestedSessionTimeout: Math.max(timeout, 10_000),
  });

  let session: ClientSession | undefined;
  try {
    await client.connect(options.endpoint);

    /*
     * 🔴 세션을 열기 전에 **상대가 누구인지 묻는다.** getEndpoints는 연결만으로 답한다.
     *    주소 문자열 비교로는 못 막는다 — 호스트명·IP가 달라도 같은 서버일 수 있다.
     */
    const identity = await describeServer(client);
    if (options.selfUri && identity.applicationUri === options.selfUri) {
      throw new SelfBrowseError(
        '이 주소는 지금 이 저작도구가 값을 내주는 OPC UA 서버입니다. ' +
          '여기서 보이는 것은 설비 태그가 아니라 열려 있는 AAS 파일의 내용입니다. ' +
          '수집할 곳은 설비(PLC)의 주소여야 합니다.',
        'self',
      );
    }
    if (identity.productUri === PRODUCT_URI) {
      throw new SelfBrowseError(
        '이 주소는 다른 컴퓨터에서 도는 같은 VEXPLOR AAS Studio입니다(AAS를 내주는 서버). ' +
          '수집할 곳은 설비(PLC)의 주소여야 합니다.',
        'sibling',
      );
    }

    session = await client.createSession();

    const nodes: BrowsedNode[] = [];
    let truncated = false;
    const seen = new Set<string>();

    const walk = async (nodeId: string, path: string, depth: number): Promise<void> => {
      if (depth > maxDepth || nodes.length >= maxNodes) {
        if (nodes.length >= maxNodes) truncated = true;
        return;
      }
      const result = await session!.browse({
        nodeId,
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: true,
        resultMask: 63,
      });
      for (const ref of result.references ?? []) {
        const childId = ref.nodeId.toString();
        if (seen.has(childId) || !isVendorNode(childId)) continue;
        seen.add(childId);
        const name = ref.browseName.name ?? childId;
        const childPath = path === '' ? name : `${path} > ${name}`;

        if (ref.nodeClass === NodeClass.Variable) {
          if (nodes.length >= maxNodes) {
            truncated = true;
            return;
          }
          nodes.push({ nodeId: childId, name, path: childPath, type: 'string' });
          continue;
        }
        if (ref.nodeClass === NodeClass.Object) await walk(childId, childPath, depth + 1);
      }
    };

    // 설비가 매달리는 자리는 Objects 폴더다
    await walk('i=85', '', 0);

    /*
     * 자료형과 현재 값을 한 번에 읽는다.
     * 🔴 노드마다 왕복하면 태그 500개에서 못 쓸 만큼 느리다 — 현장 서버는 더 느리다.
     */
    if (nodes.length > 0) {
      const dataValues = await session.read(
        nodes.map((node) => ({ nodeId: node.nodeId, attributeId: AttributeIds.Value })),
      );
      const typeNames = await session.read(
        nodes.map((node) => ({ nodeId: node.nodeId, attributeId: AttributeIds.DataType })),
      );
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]!;
        const dataValue = dataValues[index];
        const typeValue = typeNames[index];
        if (typeValue?.value?.value) {
          // DataType 속성은 NodeId로 온다 — ns=0의 표준 자료형 번호다
          node.type = aidTypeOf(String(typeValue.value.value));
        }
        if (!dataValue) continue;
        if (dataValue.statusCode === StatusCodes.Good) {
          const shown = showValue(dataValue.value?.value);
          /*
           * 값으로 **보정만** 한다 — DataType이 이미 말해 준 것을 덮지 않는다.
           * 벤더 자료형이라 번호로 못 알아낸 자리를 메우는 용도다.
           */
          if (node.type === 'string') {
            if (typeof dataValue.value?.value === 'boolean') node.type = 'boolean';
            else if (typeof dataValue.value?.value === 'number') {
              node.type = Number.isInteger(dataValue.value.value) ? 'integer' : 'float';
            }
          }
          if (shown !== undefined) node.value = shown;
        } else {
          node.error = dataValue.statusCode.name;
        }
      }
    }

    return { endpoint: options.endpoint, nodes, truncated };
  } catch (error) {
    // 자기 자신 판정은 「훑기 실패」가 아니다 — 사유가 다르므로 그대로 올린다
    if (error instanceof SelfBrowseError) throw error;
    throw error instanceof Error
      ? new Error(`${options.endpoint} 훑기 실패: ${error.message}`)
      : error;
  } finally {
    await session?.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}
