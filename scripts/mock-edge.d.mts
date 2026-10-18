/** Types of scripts/mock-edge.mjs for the TypeScript tests that drive it */
export interface MockEdgeStats {
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  retries: number;
}

export interface MockReadList {
  revision: string;
  state: 'pending-approval' | 'approved' | 'paused';
  pollSeconds: number;
  interfaces: { interfaceId: string; intervalMs: number; tags: { tagId: string; type?: string }[] }[];
}

export interface MockEdge {
  register(code: string, name?: string): Promise<{ deviceId: string }>;
  readList(): Promise<MockReadList>;
  enqueue(list: MockReadList, extraSamples?: unknown[], statusExtra?: Record<string, unknown>): Record<string, unknown> & { seq: number };
  flush(options?: { maxAttempts?: number }): Promise<string>;
  readonly stats: MockEdgeStats;
  readonly bootId: string;
  readonly identity: { deviceId?: string; publicKey: string } | undefined;
}

export function signedText(method: string, pathAndQuery: string, timestamp: number, nonce: string, device: string, body: string): string;

export function createMockEdge(options: {
  server: string;
  stateDir: string;
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): MockEdge;
