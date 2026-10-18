/**
 * Browses equipment to fetch **the list of collectable tags**.
 *
 * Why: until now, NodeIds (`ns=1;s=Machine.MotorSpeed`) were typed by hand.
 * With tens to hundreds of tags per machine that is impractical, and a single typo silently drops just that tag
 * — the reason a value is empty is the hardest thing to track down later. Connecting and reading removes both problems.
 *
 * Important: **read-only.** Nothing is written to the equipment.
 * Important: there is a cap. Field servers can have tens of thousands of nodes, and browsing them all kills the UI.
 *    Where it stopped is reported via `truncated` — silently cutting off leads to "why is that tag missing?".
 */
import { fill, tr } from '@aas/core';
import { secureClient, type SecureClientOptions } from './client-security.js';
import { PRODUCT_URI } from './server.js';
import {
  AttributeIds,
  BrowseDirection,
  NodeClass,
  OPCUAClient,
  StatusCodes,
  type ClientSession,
  type OPCUACertificateManager,
  type UserIdentityInfo,
} from 'node-opcua';

export interface BrowsedNode {
  /** Becomes the AID's href as-is */
  nodeId: string;
  /** browseName — candidate tag name */
  name: string;
  /** Where it lives, human-readable: Machine > Motor > Speed */
  path: string;
  /** Value that can go straight into the AID's type field */
  type: 'float' | 'integer' | 'boolean' | 'string';
  /** Current value — lets you visually confirm "is this the right tag?" right after connecting */
  value?: string;
  /** Unreadable tags still stay in the list. Why they fail is itself information */
  error?: string;
}

export interface BrowseResult {
  endpoint: string;
  nodes: BrowsedNode[];
  /** Whether it stopped because of the cap */
  truncated: boolean;
}

/** Who the peer is — the basis for preventing accidental self-browsing */
export interface DeviceIdentity {
  applicationUri?: string;
  productUri?: string;
  applicationName?: string;
}

export class SelfBrowseError extends Error {
  constructor(
    message: string,
    /** 'self' = this very process; 'sibling' = the same tool on another machine */
    readonly kind: 'self' | 'sibling',
  ) {
    super(message);
    this.name = 'SelfBrowseError';
  }
}

/**
 * Security, login, certificate store and trust — as the collector connects (2.8.0). Absent: None and anonymous, as
 * before. A factory server without a None endpoint could not be browsed at all until this.
 */
export interface BrowseOptions extends Omit<SecureClientOptions, 'connectTimeoutMs'> {
  endpoint: string;
  /**
   * applicationUri of the OPC UA server started by this process.
   * If given, **browsing ourselves is blocked** — the accident where the AAS we serve comes back as "tags to collect".
   */
  selfUri?: string;
  /** Default 5000 */
  connectTimeoutMs?: number;
  /** How many levels deep to go. Default 6 */
  maxDepth?: number;
  /** How many nodes to collect at most. Default 500 */
  maxNodes?: number;
}

/**
 * NodeId number of a standard data type -> one of the four AID types.
 *
 * Important: the DataType attribute **arrives as a NodeId, not a name** (`ns=0;i=11`). Searching the string as if it were
 *    a name makes everything fall through to string — caught by measurement (every integer tag became string).
 *    The numbers are fixed values from OPC UA Part 6 Annex A.
 */
const BUILTIN_TYPE: Record<number, BrowsedNode['type']> = {
  1: 'boolean',
  2: 'integer', 3: 'integer', 4: 'integer', 5: 'integer',
  6: 'integer', 7: 'integer', 8: 'integer', 9: 'integer',
  10: 'float', 11: 'float',
  12: 'string', 13: 'string',
};

/** OPC UA data type (NodeId or name) -> the four types used by AID */
export function aidTypeOf(dataType: string | undefined): BrowsedNode['type'] {
  const text = (dataType ?? '').toLowerCase();
  // ① Standard data types are known exactly by number
  const standard = /^ns=0;i=(\d+)$/.exec(text) ?? /^i=(\d+)$/.exec(text);
  if (standard) {
    const mapped = BUILTIN_TYPE[Number(standard[1])];
    if (mapped) return mapped;
  }
  // ② When it arrives as a name (vendor data types, tests) — read it as-is
  if (text.includes('bool')) return 'boolean';
  if (text.includes('double') || text.includes('float') || text.includes('decimal')) return 'float';
  if (text.includes('int') || text.includes('byte')) return 'integer';
  return 'string';
}

/** One value as a human-readable string. Arrays and structures are not expanded */
export function showValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return fill(tr('[{0}개]'), { 0: value.length });
  if (typeof value === 'object') return tr('(구조체)');
  return String(value);
}

/**
 * Skips standard nodes.
 * Important: ns=0 is OPC UA's own server information (Server_ServerStatus, etc.),
 *    not equipment values. Mixing it in makes it hard for people to find the real tags.
 */
function isVendorNode(nodeId: string): boolean {
  return !nodeId.startsWith('ns=0;') && nodeId !== 'i=85';
}

/** Identity of the peer server. Failing to read it does not block browsing — "unknown" is not the same as "not" */
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

  const secure = (options.security?.mode ?? 'None') !== 'None' || options.user !== undefined;
  let certificates: OPCUACertificateManager | undefined;
  let userIdentity: UserIdentityInfo | undefined;
  let client: OPCUAClient;
  if (secure) {
    ({ client, certificates, identity: userIdentity } = await secureClient({ ...options, connectTimeoutMs: timeout }));
  } else {
    client = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 0, initialDelay: 200, maxDelay: 1000 },
      requestedSessionTimeout: Math.max(timeout, 10_000),
    });
  }

  let session: ClientSession | undefined;
  try {
    await client.connect(options.endpoint);

    /*
     * Important: **ask who the peer is** before opening a session. getEndpoints answers on a bare connection.
     *    Comparing address strings cannot catch it — different hostnames/IPs can still be the same server.
     */
    const identity = await describeServer(client);
    if (options.selfUri && identity.applicationUri === options.selfUri) {
      throw new SelfBrowseError(
        tr('이 주소는 지금 이 저작도구가 값을 내주는 OPC UA 서버입니다. 여기서 보이는 것은 설비 태그가 아니라 열려 있는 AAS 파일의 내용입니다. 수집할 곳은 설비(PLC)의 주소여야 합니다.'),
        'self',
      );
    }
    if (identity.productUri === PRODUCT_URI) {
      throw new SelfBrowseError(
        tr('이 주소는 다른 컴퓨터에서 도는 같은 VEXPLOR AAS Studio입니다(AAS를 내주는 서버). 수집할 곳은 설비(PLC)의 주소여야 합니다.'),
        'sibling',
      );
    }

    session = await (userIdentity ? client.createSession(userIdentity) : client.createSession());

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

    // Equipment hangs off the Objects folder
    await walk('i=85', '', 0);

    /*
     * Reads data types and current values in one go.
     * Important: a round trip per node is unusably slow at 500 tags — and field servers are slower still.
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
          // The DataType attribute arrives as a NodeId — a standard data type number in ns=0
          node.type = aidTypeOf(String(typeValue.value.value));
        }
        if (!dataValue) continue;
        if (dataValue.statusCode === StatusCodes.Good) {
          const shown = showValue(dataValue.value?.value);
          /*
           * The value is used **only as a correction** — it does not override what DataType already said.
           * It fills in cases where a vendor data type could not be identified by number.
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
    // A self-detection is not a "browse failure" — the reason differs, so rethrow as-is
    if (error instanceof SelfBrowseError) throw error;
    throw error instanceof Error
      ? new Error(fill(tr('{0} 훑기 실패: {1}'), { 0: options.endpoint, 1: error.message }))
      : error;
  } finally {
    await session?.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
    await certificates?.dispose().catch(() => undefined);
  }
}
