/**
 * node:http adapter.
 *
 * Only the transport layer lives here — reading the body, parsing the query string, writing the response.
 * All decisions live under api.ts, so tests run in full without starting a server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AasxLimits } from '@aas/aasx';
import type { AuthConfig } from './auth.js';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { parsePolicy, type LinterPolicy } from '@aas/linter';
// Important: OPC UA is **loaded on first use** (import()). node-opcua has thousands of files, so on a
//    first start after the PC had evicted them from cache, just loading took over 30 s (measured 34 s on
//    2026-10-06 — the port stayed closed meanwhile and the server looked "dead"). Authoring-only users never use OPC UA.
import type { SimulatorServer } from '@aas/opcua';
const opcua = () => import('@aas/opcua');
// Modbus TCP · MQTT · S7 · MC · XGT — adapters with no external dependencies (@aas/fieldbus). Like OPC UA, loaded only on use
const fieldbus = () => import('@aas/fieldbus');
import { FolderStore, InMemoryStore, PostgresStore, visibleInWorkspace, type AasStore } from '@aas/store';
import { createApi, toErrorResponse } from './api.js';
import type { OpcUaPublisher } from './publisher.js';
import { CollectSupervisor } from './supervisor.js';
import type { BrowseSecurity } from './routes/packages.js';
import { authFromEnv, isAsciiToken, isOpen, resolveBindHost } from './auth.js';
import { ApiError, json, JSON_TYPE, ServiceBusyError, type ApiRequest } from './http.js';
import { isDocumentRequest, openStatic, resolveStatic } from './static.js';
import { seedTemplates } from './templates.js';
import { retentionDaysFromEnv, startRetention } from './retention.js';
import { corsFromEnv, corsHeaders, isPreflight, type CorsPolicy } from './cors.js';
import { demoOutboundAllowed, isHttps, OutboundBlockedError, securityHeaders, setupCode, setupCodeRequired } from './security.js';
import { demoFromEnv, seedDemoUser, startDemoReset } from './demo.js';
import { hashPassword, verifyPassword } from './password.js';
import { fill, jsonDepthExceeds, tr } from '@aas/core';
import { bootLang, langOfRaw, runInLang } from './lang.js';
import { startIntegrations, type IntegrationBoot, type StartIntegrationsOptions } from './integration/boot.js';
import { integrationComposition } from './integration/compose.js';
import {
  opcuaClientPkiDirFromEnv,
  opcuaClientTrustsFirstUse,
  opcuaModeFromEnv,
  opcuaPkiDirFromEnv,
  parseOpcUaCredentials,
  type OpcUaCredential,
} from './integration/opcua-env.js';
import { LoginThrottle } from './session.js';
import type { StoreKind } from './integration/secrets.js';

/** Deepest JSON request body accepted — well above any AAS model (64 element levels ≈ 144 JSON levels) */
const MAX_REQUEST_JSON_DEPTH = 512;

/** Upload cap — guards against zip bombs (spec Ⅷ, security). Default 512MB */
const DEFAULT_MAX_BODY = 512 * 1024 * 1024;

/**
 * Body cap for this server.
 * Important: when `AASX_MAX_TOTAL_MB` lowers the decompression cap, the body cap follows it (twice that, so a bundle
 *    carrying a package and its kept original still fits), never above the default. Otherwise an operator who set a
 *    small AASX cap to save memory still accepted 512 MB bodies held whole in memory (red-team L9, 2026-10-16).
 *    An explicit `maxBodyBytes` wins.
 */
export function bodyLimitFor(options: Pick<ServerOptions, 'maxBodyBytes'>, limits: Partial<AasxLimits> | undefined): number {
  if (options.maxBodyBytes !== undefined) return options.maxBodyBytes;
  const total = limits?.maxTotalUncompressedBytes;
  if (total === undefined || !Number.isFinite(total) || total <= 0) return DEFAULT_MAX_BODY;
  return Math.min(DEFAULT_MAX_BODY, total * 2);
}

/**
 * Large uploads in flight at once (red-team L9, 2026-10-16).
 * Important: a body is held in memory whole and then parsed, so a few parallel 500 MB uploads exhaust the server.
 *    Bodies past `thresholdBytes` take one of `maxConcurrent` slots; with none free the request gets 503 + Retry-After
 *    at once instead of being read. Small requests never touch the slots.
 */
class LargeUploadSlots {
  private used = 0;

  constructor(
    readonly thresholdBytes: number,
    private readonly maxConcurrent: number,
  ) {}

  take(): () => void {
    if (this.used >= this.maxConcurrent) {
      throw new ServiceBusyError(tr('지금은 큰 파일을 올리는 사람이 많습니다. 잠시 뒤에 다시 올려 주십시오.'), 30);
    }
    this.used += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= 1;
    };
  }
}

export interface ServerOptions {
  store?: AasStore;
  port?: number;
  maxBodyBytes?: number;
  /** Decompression cap for uploaded AASX. Can also be set via the AASX_MAX_TOTAL_MB env var */
  aasxLimits?: Partial<AasxLimits>;
  /** Large uploads held in memory at once — default: 2 bodies over 32 MB (LargeUploadSlots) */
  largeUploads?: { thresholdBytes?: number; maxConcurrent?: number };
  /**
   * Whether to enable collection (M8). Off by default — an authoring-only deployment has no reason to load the OPC UA stack.
   * Can also be enabled with the env var `COLLECT=on`.
   */
  collect?: boolean;
  /** Access control. If omitted, read from env vars (AAS_TOKEN, AAS_READONLY_TOKEN) */
  auth?: AuthConfig;
  /** Allowed cross origins. If omitted, read from env var `CORS_ORIGIN`. If empty, no CORS headers are sent */
  cors?: CorsPolicy;
  /**
   * Whether to serve the authoring UI build (`apps/web/dist`) on the same port. Can also be set via env var `WEB_ROOT`.
   * If omitted, enabled only when `apps/web/dist` exists — so it does not get in the way during development (vite 5173).
   */
  webRoot?: string;
  /** Which store this is — decides where the integration master key comes from. Derived from the store when omitted */
  storeKind?: StoreKind;
  /** Data folder of a folder store (`AAS_DATA_DIR`) — holds `secret.key` */
  dataDir?: string;
  /** Tests only — environment on top of process.env, injected DNS and sender for the integration subsystem */
  integrationOverrides?: Pick<StartIntegrationsOptions, 'resolve' | 'send'> & { env?: Record<string, string> };
}

/** The integration subsystem of each server — the entry block stops it on SIGTERM / SIGINT */
const integrationBoots = new WeakMap<Server, IntegrationBoot>();

export function integrationsOf(server: Server): IntegrationBoot | undefined {
  return integrationBoots.get(server);
}

function storeKindOf(store: AasStore): StoreKind {
  if (store instanceof PostgresStore) return 'postgres';
  if (store instanceof FolderStore) return 'folder';
  return 'memory';
}

/**
 * Reads the policy file (`AAS_POLICY_FILE`).
 *
 * Important: if the file exists but is invalid, **do not start.** Failing to start is better than running
 *    with the policy silently ignored — finding out "I changed it but nothing changed" after submission cannot be undone.
 */
function policyFromFile(): Partial<LinterPolicy> {
  const path = process.env['AAS_POLICY_FILE'];
  if (!path) return {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(fill(tr('정책 파일을 읽지 못했습니다: {0} — {1}'), { 0: path, 1: String(error) }));
  }
  const { policy, changed } = parsePolicy(text);
  console.log(
    `  ${fill(tr('정책 파일: {0} — {1}'), {
      0: path,
      1: changed.length === 0 ? tr('기본값과 같음') : fill(tr('바꾼 항목 {0}'), { 0: changed.join(', ') }),
    })}`,
  );
  return policy;
}

/** Where to serve the UI from — explicit value > env var > default if it exists */
function webRootFrom(explicit: string | undefined): string | undefined {
  const chosen = explicit ?? process.env['WEB_ROOT'];
  if (chosen) return resolve(chosen);
  const guess = resolve(process.cwd(), 'apps/web/dist');
  return existsSync(guess) ? guess : undefined;
}

/** Limits are tunable via env var — memory differs per deployment */
function limitsFromEnv(): Partial<AasxLimits> | undefined {
  const megabytes = Number(process.env['AASX_MAX_TOTAL_MB']);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return undefined;
  return { maxTotalUncompressedBytes: Math.floor(megabytes * 1024 * 1024) };
}

async function readBody(request: IncomingMessage, limit: number, large?: BodySlot): Promise<Uint8Array> {
  const tooLarge = (): ApiError =>
    new ApiError(413, 'PayloadTooLarge', fill(tr('본문이 상한({0} 바이트)을 넘었습니다.'), { 0: limit }));
  // Decide from the announced length before reading anything — refusing after buffering would defeat the point
  const announced = Number(request.headers['content-length']);
  if (Number.isFinite(announced) && announced > limit) throw tooLarge();
  if (large && Number.isFinite(announced) && announced > large.slots.thresholdBytes) large.claim();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = chunk as Uint8Array;
    size += data.length;
    if (size > limit) throw tooLarge();
    // Chunked bodies announce nothing — take the slot when the body actually grows past the threshold
    if (large && size > large.slots.thresholdBytes) large.claim();
    chunks.push(data);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** One request's claim on a large-upload slot — claimed at most once, released by the request handler */
interface BodySlot {
  slots: LargeUploadSlots;
  claim(): void;
}

/** Body limit of the signed edge endpoints — twice the contract's default batch limit, so the route answers the precise 413 */
const EDGE_BODY_LIMIT = 2 * 1024 * 1024;

export async function toApiRequest(
  request: IncomingMessage,
  limit: number,
  large?: BodySlot,
): Promise<ApiRequest> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const query: Record<string, string> = {};
  const queryAll: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
    queryAll[key] = [...(queryAll[key] ?? []), value];
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }

  const raw = await readBody(request, limit, large);
  const contentType = headers['content-type'] ?? '';
  let body: unknown;
  // Kept for every body, JSON or not — the edge contract signs these bytes, so a non-JSON body must not be left unsigned
  const rawBody = raw.length > 0 ? raw : undefined;
  if (raw.length > 0) {
    // Parse JSON; pass anything else (AASX uploads) through as raw bytes
    if (contentType.includes('json')) {
      const text = new TextDecoder().decode(raw);
      // Important: refused before parsing — routes walk models recursively, and a body nested thousands deep would
      //    overflow the stack there (red-team L7). Real AAS JSON stays far below this
      if (jsonDepthExceeds(text, MAX_REQUEST_JSON_DEPTH)) {
        throw new ApiError(400, 'BadRequest', fill(tr('JSON 본문이 너무 깊게 겹쳐 있습니다 — {0}단계까지 받습니다.'), { 0: MAX_REQUEST_JSON_DEPTH }));
      }
      try {
        body = JSON.parse(text);
      } catch (error) {
        // A broken body is the client's mistake — 400, not a 500 that reads like a server fault
        throw new ApiError(400, 'BadRequest', fill(tr('JSON 본문을 읽지 못했습니다: {0}'), { 0: (error as Error).message }));
      }
    } else {
      body = raw;
    }
  }

  const remote = request.socket.remoteAddress;
  return {
    method: request.method ?? 'GET',
    path: url.pathname,
    query,
    queryAll,
    headers,
    body,
    ...(rawBody ? { rawBody } : {}),
    // The request target exactly as sent — the edge signs it (review M7); rebuilding it from the parsed URL would not match
    ...(request.url ? { rawTarget: request.url } : {}),
    ...(remote ? { remoteAddress: remote } : {}),
  };
}

export function createHttpServer(options: ServerOptions = {}): Server {
  const store = options.store ?? new InMemoryStore();
  const aasxLimits = options.aasxLimits ?? limitsFromEnv();
  const collect = options.collect ?? process.env['COLLECT'] === 'on';
  // The rule-conflict choice is set per deployment. Individual requests can override it with a query parameter
  const standardTerms = process.env['LINT_STANDARD_TERMS'];
  const policy: Partial<LinterPolicy> = {
    // Important: the policy file comes first. When the conventions change, edit the file, not the code
    ...policyFromFile(),
    ...(standardTerms === 'preserve' || standardTerms === 'kosmo-first'
      ? { standardTemplateSemantics: standardTerms }
      : {}),
  };
  const auth = options.auth ?? authFromEnv(process.env);
  const cors = options.cors ?? corsFromEnv(process.env);
  const publicBaseUrl = process.env['AAS_PUBLIC_URL'];
  // Several places below check demo mode (OPC UA refusal, download block, signup) — read it up front
  const demo = demoFromEnv(process.env);
  const simulatorPort = Number(process.env['SIMULATOR_PORT'] ?? 14850);
  /** In demo mode, make no outbound connections except to the virtual PLC (SSRF block — security.ts) */
  const guardOutbound = (endpoint: string): void => {
    if (demo && !demoOutboundAllowed(endpoint, simulatorPort)) throw new OutboundBlockedError();
  };

  /** OPC UA user names and passwords (OPCUA_CLIENT_CREDENTIALS), read on first need — a broken file fails that connection */
  let credentials: Map<string, OpcUaCredential> | undefined;
  const opcuaCredentials = (): Map<string, OpcUaCredential> => {
    const file = process.env['OPCUA_CLIENT_CREDENTIALS']?.trim();
    credentials ??= file ? parseOpcUaCredentials(readFileSync(file, 'utf8')) : new Map();
    return credentials;
  };

  /**
   * Connects to the address the AID specifies — OPC UA via @aas/opcua, Modbus TCP · MQTT · S7 · MC · XGT via @aas/fieldbus (2026-10-14).
   * In demo mode all three go through guardOutbound — everything except the virtual PLC (OPC UA) is blocked.
   */
  const openReader = async (descriptor: AidInterface): Promise<ProtocolReader> => {
    if (descriptor.protocol === 'MODBUS') {
      if (!descriptor.base) throw new Error(tr('EndpointMetadata.base가 없습니다.'));
      guardOutbound(descriptor.base);
      return (await fieldbus()).ModbusReader.connect(descriptor, { guard: guardOutbound });
    }
    if (descriptor.protocol === 'S7' || descriptor.protocol === 'MC' || descriptor.protocol === 'XGT') {
      // VEXPLOR extension bindings, read only (S7 · MC 2.10.0, XGT after it) — no login; the guard sees the address before any connection
      if (!descriptor.base) throw new Error(tr('EndpointMetadata.base가 없습니다.'));
      guardOutbound(descriptor.base);
      const bus = await fieldbus();
      if (descriptor.protocol === 'XGT') return bus.XgtReader.connect(descriptor, { guard: guardOutbound });
      return descriptor.protocol === 'S7' ? bus.S7Reader.connect(descriptor, { guard: guardOutbound }) : bus.McReader.connect(descriptor, { guard: guardOutbound });
    }
    if (descriptor.protocol === 'MQTT') {
      // A login the AID asks for (2.8.0) comes from the installer's file by address, never from the AAS
      const login = descriptor.security?.userIdentityToken === 'UserName';
      const user = login && descriptor.base ? opcuaCredentials().get(descriptor.base) : undefined;
      if (login && !user) {
        throw new Error(fill(tr('{0} 은(는) 로그인을 요구합니다 — OPCUA_CLIENT_CREDENTIALS 파일에 이 주소의 항목을 넣으십시오.'), { 0: descriptor.base ?? '' }));
      }
      return (await fieldbus()).MqttReader.connect(descriptor, { guard: guardOutbound, ...(user ? { user } : {}) });
    }
    if (descriptor.protocol !== 'OPCUA') {
      throw new Error(fill(tr('아직 지원하지 않는 프로토콜입니다: {0}'), { 0: descriptor.protocol }));
    }
    if (!descriptor.base) throw new Error(tr('EndpointMetadata.base가 없습니다.'));
    guardOutbound(descriptor.base);
    // Security as the AID states it (AID 1.1); the user name and password from the installer's file, never from the AAS
    const security = descriptor.security;
    const user = security?.userIdentityToken === 'UserName' ? opcuaCredentials().get(descriptor.base) : undefined;
    if (security?.userIdentityToken === 'UserName' && !user) {
      throw new Error(fill(tr('{0} 은(는) 사용자 이름 로그인을 요구합니다 — OPCUA_CLIENT_CREDENTIALS 파일에 이 주소의 항목을 넣으십시오.'), { 0: descriptor.base }));
    }
    return (await opcua()).OpcUaReader.connect({
      endpoint: descriptor.base,
      ...(security?.mode ? { security: { mode: security.mode, ...(security.policy ? { policy: security.policy } : {}) } } : {}),
      ...(user ? { user } : {}),
      pkiDir: opcuaClientPkiDirFromEnv(process.env),
      trustUnknownServer: opcuaClientTrustsFirstUse(process.env),
    });
  };

  /**
   * Built-in virtual PLC (simulation) — how an evaluator with only the installed build can reproduce a bundle. Only on servers
   * with collection enabled, started the first time "Connect to virtual PLC" is pressed (port SIMULATOR_PORT, default 14850)
   */
  let simulator: Promise<SimulatorServer> | undefined;
  const simulatorOnce = (): Promise<SimulatorServer> =>
    // Hold on to the promise — even if pressed twice concurrently, only one virtual PLC starts
    (simulator ??= opcua().then(
      ({ SimulatorServer: Simulator }) => new Simulator({ port: simulatorPort }),
    ));

  /**
   * Continuous periodic collection. Runs only with `COLLECT=on` + `COLLECT_INTERVAL=<seconds>` —
   * an authoring-only deployment has no reason to poll equipment periodically.
   */
  const intervalSeconds = Number(process.env['COLLECT_INTERVAL']);
  const collectIntervalMs = collect && Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : undefined;

  /**
   * MES / ERP / CMMS integration (integration/boot.ts). Started **before** the supervisor — the supervisor hands each
   * package's cycle to the detector. Event recording and the pull feed work regardless; INTEGRATIONS=on starts the workers.
   */
  const storeKind = options.storeKind ?? storeKindOf(store);
  const dataDir = options.dataDir ?? (storeKind === 'folder' ? process.env['AAS_DATA_DIR'] : undefined);
  // One login attempt limit for the web login and the OPC UA account check
  const loginThrottle = new LoginThrottle();
  const overrides = options.integrationOverrides;
  const integrations = startIntegrations({
    store,
    env: overrides?.env ? { ...process.env, ...overrides.env } : process.env,
    ...(overrides?.resolve ? { resolve: overrides.resolve } : {}),
    ...(overrides?.send ? { send: overrides.send } : {}),
    demo: demo !== undefined,
    storeKind,
    ...(dataDir ? { dataDir } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(collectIntervalMs ? { collectIntervalMs } : {}),
    compose: integrationComposition(),
    // The OPC UA trust store must be reachable also with INTEGRATIONS off (certificate routes)
    opcuaPki: () => publisher?.pki(),
    opcuaStatus: () => {
      const status = publisher?.status();
      // The configured store is shown also before (or instead of) a start — that is where a client certificate will land
      const pki = status?.pki ?? (opcuaModeFromEnv(process.env) === 'secure' ? opcuaPkiDirFromEnv(process.env) : undefined);
      return { running: status?.running ?? false, ...(pki ? { pki } : {}) };
    },
    log: (line) => console.log(`  ${line}`),
  });

  let supervisor: CollectSupervisor | undefined;
  if (collectIntervalMs !== undefined) {
    // Each package's cycle also goes to the detector (runtime events) when integrations run
    supervisor = new CollectSupervisor({
      store,
      openReader,
      intervalMs: collectIntervalMs,
      ...(integrations.onPackageCycle ? { onPackageCycle: integrations.onPackageCycle } : {}),
    });
    supervisor.start();
  }

  /**
   * OPC UA exposure — spec M6·M7. "The authoring tool itself becomes an OPC UA server" (spec Ⅱ-3).
   *
   * Important: off by default. Enabling it **opens one more port with no authentication** — unlike the HTTP
   *    token auth, so opening it must be an explicit decision by whoever deploys.
   */
  /**
   * Important: **not started in demo mode.** The OPC UA exposure port has no authentication yet.
   *    On an internal network, "only visible inside the network" is the defense, but a demo is **a publicly
   *    exposed server**, so that premise breaks entirely. Enabling both is likely a mistake, so refuse and say so.
   */
  if (demo && process.env['OPCUA_SERVER'] === 'on') {
    console.error('  [WARN] ' + tr('체험 버전(DEMO_MODE=on)에서는 OPC UA 노출을 켜지 않습니다 — 그 포트에는 인증이 없습니다.'));
  }
  const publishing = process.env['OPCUA_SERVER'] === 'on' && !demo;
  let publisher: OpcUaPublisher | undefined;
  if (publishing) {
    // Authoring must keep working even if this server fails to start — log the reason and continue
    // Secure by default (design §7, D16): no None policy, no anonymous, user names = this server's accounts
    const mode = opcuaModeFromEnv(process.env);
    void import('./publisher.js')
      .then(async ({ OpcUaPublisher: Publisher, accountVerifier }) => {
        // Important: secure mode with no account would be a port nobody can log in to — say so instead of starting it
        if (mode === 'secure' && (await store.countUsers()) === 0) {
          console.error('  [WARN] ' + tr('OPC UA 서버를 띄우지 않았습니다 — 보안 모드에는 로그인할 계정이 필요합니다. 계정을 만든 뒤 다시 띄우거나, 예전처럼 인증 없이 열려면 OPCUA_ALLOW_INSECURE=on.'));
          return;
        }
        publisher = new Publisher({
          store,
          port: Number(process.env['OPCUA_PORT'] ?? 4840),
          refreshMs: Math.max(1, Number(process.env['OPCUA_REFRESH'] ?? 5)) * 1000,
          ...(process.env['OPCUA_HOST'] ? { hostname: process.env['OPCUA_HOST'] } : {}),
          security:
            mode === 'secure'
              ? { mode, verifyUser: accountVerifier(store, loginThrottle), pkiDir: opcuaPkiDirFromEnv(process.env) }
              : { mode },
        });
        await publisher.start();
        // Said only once it really runs — a refused start must not be logged as "on" (live E2E, D4)
        const every = Math.max(1, Number(process.env['OPCUA_REFRESH'] ?? 5));
        console.log('  ' + fill(tr('OPC UA 노출(M6·M7) 켜짐 — opc.tcp://<이 서버>:{0}/UA/AAS · {1}초마다 갱신'), { 0: Number(process.env['OPCUA_PORT'] ?? 4840), 1: every }));
        console.log('     ' + tr('상위 앱(MES·SCADA)이 구독으로 값을 받아 갑니다 · GET /opcua-status'));
        if (mode === 'secure') {
          console.log('     ' + fill(tr('보안 모드 — 이 서버의 계정으로 로그인 · 처음 접속한 클라이언트 인증서는 관리자가 신뢰해야 합니다 (인증서 저장소: {0})'), { 0: opcuaPkiDirFromEnv(process.env) }));
        } else {
          // Important: this must be said at least once — HTTP may be token-protected, but this port is not
          console.log('     [WARN] ' + tr('이 포트에는 인증이 없습니다(OPCUA_ALLOW_INSECURE=on). 사내망 밖으로 열지 마십시오.'));
        }
      })
      .catch((error: unknown) => {
      console.error(
        '  [WARN] ' + fill(tr('OPC UA 서버를 띄우지 못했습니다: {0}'), { 0: error instanceof Error ? error.message : String(error) }),
      );
    });
  }

  // Important: on an externally reachable server, ask for a setup code so **nobody can grab** the first admin.
  //    A server open only on this computer (protected mode) does not ask — the user is the one sitting at the server
  const needsSetupCode = setupCodeRequired(resolveBindHost(process.env, auth).protected);

  // Signup is **closed** by default. A demo server only makes sense with signup, so it is opened along with it
  // Important: self-registered users **cannot become admins.** Accepting AAS_SIGNUP_ROLE=admin would turn the signup
  //    button into an admin-issuing button — opening account management, viewing all workspaces, even locking others' accounts.
  //    Admins are promoted by an existing admin under "Settings → Account management"
  const signupRole: 'editor' | 'viewer' = process.env['AAS_SIGNUP_ROLE'] === 'viewer' ? 'viewer' : 'editor';
  // Important: without a privacy policy URL, contact details are **not collected.** The point is not to
  //    gather personal data without stating how it is used (routes/auth.ts)
  const privacyUrl = process.env['AAS_PRIVACY_URL']?.trim();
  const signup =
    process.env['AAS_SIGNUP'] === 'on' || demo
      ? {
          role: signupRole,
          ...(privacyUrl ? { privacyUrl } : {}),
        }
      : undefined;

  const handle = createApi(store, {
    auth,
    // The admin's server status reports the store and the disk it writes to (routes/server-status.ts)
    server: { storeKind, ...(dataDir ? { dataDir } : {}), startedAt: new Date() },
    ...(demo ? { demo } : {}),
    ...(signup ? { signup } : {}),
    // Whether to give each person a separate workspace. In demo mode createApi enables it by itself
    ...(process.env['AAS_WORKSPACE'] === 'private' ? { privateWorkspaces: true } : {}),
    ...(needsSetupCode ? { setupCode: setupCode(process.env) } : {}),
    // Writes arriving via a cookie session have their origin checked (security.ts). Allowed cross origins pass
    corsOrigins: cors.origins,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(integrations.runtimeDeps ? { integration: integrations.runtimeDeps } : {}),
    integrationServices: integrations.services,
    loginThrottle,
    ...(collectIntervalMs ? { collectIntervalMs } : {}),
    // Remote collectors (docs/edge-contract.md) — EDGE=on: on · EDGE=off: off · not set: an admin switches it on in the
    // screen (off until then). createApi keeps it off in demo mode
    ...(process.env['EDGE'] === 'off'
      ? {}
      : { edge: { ...(collectIntervalMs ? { intervalMs: collectIntervalMs } : {}), mode: process.env['EDGE'] === 'on' ? ('on' as const) : ('switchable' as const) } }),
    routes: [
      {
        /** What is being exposed externally — where the UI and operators check */
        method: 'GET',
        pattern: '/opcua-status',
        handle: async () =>
          json(
            200,
            publisher
              ? publisher.status()
              : {
                  running: false,
                  packages: 0,
                  variables: 0,
                  reason: publishing ? tr('OPC UA 서버를 띄우는 중입니다.') : tr('OPCUA_SERVER=on이 아닙니다.'),
                },
          ),
      },
      {
        /** Answers "is it actually running?" — the result of the last cycle */
        method: 'GET',
        pattern: '/collect-status',
        handle: async () => {
          if (!supervisor) {
            return json(200, {
              // collect — whether this server can collect (and use the virtual PLC). The UI decides from this whether to show the button
              collect,
              running: false,
              reason: tr('COLLECT_INTERVAL이 설정되지 않았습니다 (수동 수집만).'),
            });
          }
          const status = supervisor.status();
          // Important: the last cycle's result covers **all packages** (the server runs it itself). Returned as is,
          //    a server with separate workspaces would reveal other people's file names and equipment addresses.
          //    It is "pre-aggregated" data the store layer cannot filter, so filter it here where it is served
          if (status.lastSweep) {
            const results = [];
            for (const result of status.lastSweep.results) {
              if (visibleInWorkspace(await store.getPackage(result.packageId))) results.push(result);
            }
            status.lastSweep = {
              ...status.lastSweep,
              results,
              packages: results.length,
              collected: results.reduce((sum, result) => sum + result.collected, 0),
            };
          }
          return json(200, { collect, ...status });
        },
      },
    ],
    ...(aasxLimits ? { aasxLimits } : {}),
    ...(Object.keys(policy).length > 0 ? { policy } : {}),
    ...(collect ? { openReader } : {}),
    ...(collect
      ? {
          simulate: async (environment: Parameters<SimulatorServer['attach']>[0]) => ({
            ...(await (await simulatorOnce()).attach(environment)),
            // Connection name written into the file — in the creator's language. Evidence is judged by path/marker, not by name (evidence.ts)
            title: tr((await opcua()).SIMULATOR_TITLE),
          }),
        }
      : {}),
    // Important: browsing must work even with collection off — it is needed **while creating** an AID.
    //    Pass our own server identity along to prevent **the server browsing itself** by accident.
    browseDevice: async (endpoint: string, chosen?: { security: BrowseSecurity }) => {
      guardOutbound(endpoint);
      const self = publisher?.status().instanceUri;
      // The security the screen chose (2.8.0) — certificate store and trust as the collector uses them, login from the file
      const security = chosen?.security;
      const user = security?.login ? opcuaCredentials().get(endpoint) : undefined;
      if (security?.login && !user) {
        throw new Error(fill(tr('{0} 은(는) 사용자 이름 로그인을 요구합니다 — OPCUA_CLIENT_CREDENTIALS 파일에 이 주소의 항목을 넣으십시오.'), { 0: endpoint }));
      }
      return (await opcua()).browseDevice({
        endpoint,
        ...(self ? { selfUri: self } : {}),
        ...(security && security.mode !== 'None' ? { security: { mode: security.mode, ...(security.policy ? { policy: security.policy } : {}) } } : {}),
        ...(user ? { user } : {}),
        pkiDir: opcuaClientPkiDirFromEnv(process.env),
        trustUnknownServer: opcuaClientTrustsFirstUse(process.env),
      });
    },
  });
  const limit = bodyLimitFor(options, aasxLimits);
  const largeSlots = new LargeUploadSlots(
    options.largeUploads?.thresholdBytes ?? 32 * 1024 * 1024,
    options.largeUploads?.maxConcurrent ?? 2,
  );
  const webRoot = webRootFrom(options.webRoot);
  let ready: Promise<void> | undefined;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    // Important: set the language once more here — errors sent before reaching createApi, like the body cap (413),
    //    must also be in the request's language. It also keeps the startup log language (AAS_LANG) from leaking into requests
    void runInLang(langOfRaw(request.url, request.headers['accept-language']), async () => {
      // Security headers attached to every response. Important: **they must be on static files too** — what CSP
      // protects is precisely that UI. Adding them only to API responses would leave the app page itself unprotected.
      // Important: computed **outside** the try — error responses written by the catch below need them as well
      //    (red-team L5, 2026-10-16: a 413 or a broken-JSON error went out with no headers at all)
      const guard = securityHeaders(isHttps(request.headers, (request.socket as { encrypted?: boolean }).encrypted === true));
      let release: (() => void) | undefined;
      try {
        // Static files come first. Only real files are intercepted, so this never collides with API paths.
        // Important: no authentication here — the UI must load for the user to enter a token

        if (webRoot && (request.method === 'GET' || request.method === 'HEAD')) {
          const path = new URL(request.url ?? '/', 'http://localhost').pathname;
          const asset = await resolveStatic(webRoot, path);
          if (asset) {
            writeFile(request, response, asset, guard);
            return;
          }
        }

        // Cross origin — headers are added only for an allowed Origin. Preflight must be answered before auth
        // so the browser can send the actual request (the token comes with the actual request)
        const corsExtra = corsHeaders(cors, request.headers.origin);
        if (isPreflight(request.method ?? '', request.headers)) {
          write(response, Object.keys(corsExtra).length > 0 ? 204 : 403, { ...guard, ...corsExtra }, undefined);
          return;
        }

        ready ??= store.init();
        await ready;
        // The edge sends batches of at most 1 MiB (docs/edge-contract.md §6) — refuse more while reading, not after (review M6)
        const apiRequest = await toApiRequest(request, (request.url ?? '').startsWith('/edge/v1/') ? Math.min(limit, EDGE_BODY_LIMIT) : limit, {
          slots: largeSlots,
          claim() {
            release ??= largeSlots.take();
          },
        });
        const apiResponse = await handle(apiRequest);

        // If the API does not know the path but a browser asked for a page, serve the app shell
        // (reload, bookmarks). API (JSON) requests get the 404/401 as is.
        // Why 401 too: with auth enabled, authorization runs before path matching, so unknown paths also become 401.
        // The shell is available to anyone anyway, so serving it here leaks nothing
        if (
          (apiResponse.status === 404 || apiResponse.status === 401) &&
          webRoot &&
          isDocumentRequest(request.method ?? 'GET', request.headers.accept)
        ) {
          const shell = await resolveStatic(webRoot, '/index.html');
          if (shell) {
            writeFile(request, response, shell, guard);
            return;
          }
        }

        write(response, apiResponse.status, { ...guard, ...corsExtra, ...apiResponse.headers }, apiResponse.body);
      } catch (error) {
        const fallback = toErrorResponse(error);
        // Important: a refused body was not read — close the connection rather than leave the rest of it in the pipe
        if (fallback.status === 413 || fallback.status === 503) response.setHeader('connection', 'close');
        write(response, fallback.status, { ...guard, ...fallback.headers }, fallback.body);
      } finally {
        // The body stays in memory until the response is written, so the slot is held until here
        release?.();
      }
    });
  });
  integrationBoots.set(server, integrations);
  // Closing the server (tests, embedding) also stops the integration loops — no timers left behind
  server.on('close', () => {
    void integrations.stop();
    // The OPC UA port belongs to this server's lifetime too (tests open and close servers in one process)
    void publisher?.stop();
  });
  return server;
}

/** Stream files instead of reading them whole — to avoid doubling memory use on large files */
function writeFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: Awaited<ReturnType<typeof resolveStatic>> & object,
  guard: Record<string, string> = {},
): void {
  response.writeHead(200, {
    ...guard,
    'content-type': file.contentType,
    'content-length': String(file.size),
    'cache-control': file.cacheControl,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  openStatic(file).pipe(response);
}

function write(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): void {
  if (body === undefined) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  if (body instanceof Uint8Array) {
    response.writeHead(status, headers);
    response.end(body);
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': JSON_TYPE, ...headers });
  response.end(text);
}

/**
 * Choosing the store — one of three.
 *
 *  ① `DATABASE_URL`   PostgreSQL. For many users sharing and long-term accumulation of collected values (deployment setup)
 *  ② `AAS_DATA_DIR`   Files in that folder. **For single users — no Docker needed**
 *  ③ neither          Memory. Gone when the server stops (demos, development)
 *
 * Important: ② exists to make installation easy. "Start a database if you want files to persist" was
 *    too much for a single user (user feedback, 2026-08-25). The startup log states which one is in use.
 */
async function storeFromEnv(): Promise<{ store: AasStore; kind: string }> {
  const url = process.env['DATABASE_URL'];
  const dir = process.env['AAS_DATA_DIR'];
  if (!url && dir) {
    const { FolderStore } = await import('@aas/store');
    const store = new FolderStore(dir);
    await store.init();
    return { store, kind: `folder (${dir})` };
  }
  if (!url) return { store: new InMemoryStore(), kind: 'memory' };
  const { connectPostgres, poolMaxFromEnv } = await import('./pg.js');
  const schema = process.env['DATABASE_SCHEMA'];
  const { timescaleFeaturesFromEnv } = await import('./timescale.js');
  const { store, timescale } = await connectPostgres({
    connectionString: url,
    ...(schema ? { schema } : {}),
    poolMax: poolMaxFromEnv(process.env),
    features: { settings: timescaleFeaturesFromEnv(process.env), retentionDays: retentionDaysFromEnv(process.env) },
  });
  return { store, kind: fill(tr('postgres{0} · 수집값 {1}'), { 0: schema ? ` (schema ${schema})` : '', 1: timescale }) };
}

/** Started directly with `node dist/server.js`. Startup logs and periodic-job messages use the AAS_LANG language (lang.ts) */
if (process.argv[1]?.endsWith('server.js')) await runInLang(bootLang(process.env), async () => {
  const port = Number(process.env['PORT'] ?? 8080);
  const { store: bootStore, kind } = await storeFromEnv();
  // Template folder (optional) — preloads AASX files that serve as sources for "Import from another file"
  const templatesDir = process.env['AAS_TEMPLATES_DIR'];
  const seeded = templatesDir ? await seedTemplates(bootStore, templatesDir, limitsFromEnv()) : undefined;
  // Retention period for collected values (optional) — prune once at startup, then every hour
  const retentionDays = retentionDaysFromEnv(process.env);
  const retention = startRetention(bootStore, retentionDays);
  const prunedAtBoot = await retention.pruneNow().catch((error: unknown) => {
    console.error('  [WARN] ' + fill(tr('수집값 정리 실패: {0}'), { 0: error instanceof Error ? error.message : String(error) }));
    return 0;
  });
  // Demo mode — seed the account and periodically clear uploads (demo.ts)
  const bootDemo = demoFromEnv(process.env);
  const demoSeeded = bootDemo ? await seedDemoUser(bootStore, bootDemo, hashPassword, verifyPassword) : undefined;
  if (bootDemo) startDemoReset(bootStore, bootDemo.resetMinutes, (line) => console.log(`  ${line}`));

  const bootAuth = authFromEnv(process.env);
  const bootUserCount = await bootStore.countUsers();
  const bind = resolveBindHost(process.env, bootAuth);
  const app = createHttpServer({ port, store: bootStore });

  // Important: only this entry block takes over the process signals — a library user (tests) must keep its own.
  //    Stopping lets deliveries in flight finish (≤ 5 s) and closes MQTT connections cleanly; rows still in flight
  //    come back after their lease anyway (at-least-once)
  const shutdown = (signal: string): void => {
    console.log('  ' + fill(tr('{0} — 연동 작업을 정리하고 끕니다.'), { 0: signal }));
    void (integrationsOf(app)?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  // Important: on Windows, `localhost` resolves to IPv6 (::1) first. Protected mode binds only to IPv4 (127.0.0.1),
  //    so the browser reports "can't connect" (observed: the page did not load in the Windows app build).
  //    Bind the same handler to the IPv6 loopback as well — this does not expose anything externally.
  //    Some environments (IPv6 disabled) can't do this, so failures are simply ignored.
  if (bind.protected) {
    const handler = app.listeners('request')[0] as Parameters<typeof createServer>[0];
    const twin = createServer(handler);
    twin.on('error', () => undefined);
    twin.listen(port, '::1');
  }

  app.listen(port, bind.host, () => {
    console.log(fill(tr('AAS API가 http://localhost:{0} 에서 대기합니다.'), { 0: port }));
    console.log('  ' + tr('Part 2 기저 경로: /packages/{packageId}/api/v3.0'));
    console.log('  ' + fill(tr('저장소: {0}'), { 0: kind }));
    if (kind === 'memory') {
      console.log('     [WARN] ' + tr('서버를 끄면 올린 파일이 사라집니다.'));
      console.log('        ' + tr('남기려면 AAS_DATA_DIR=<폴더> (혼자 쓸 때) 또는 DATABASE_URL (여럿이 쓸 때).'));
    } else if (kind.startsWith('folder')) {
      console.log('     ' + tr('껐다 켜도 남습니다. 그 폴더를 통째로 복사하면 그대로 옮겨집니다.'));
    }
    const root = webRootFrom(undefined);
    console.log(root ? '  ' + fill(tr('저작 UI: 같은 포트에서 내줍니다 ({0})'), { 0: root }) : '  ' + tr('저작 UI: 없음 (API만)'));
    const corsOrigins = corsFromEnv(process.env).origins;
    if (corsOrigins.length > 0) {
      console.log('  ' + fill(tr('교차 출처(CORS) 허용: {0}'), { 0: corsOrigins.join(', ') }));
      if (corsOrigins.includes('*')) console.log('     [WARN] ' + tr('모든 출처에 열려 있습니다 — 사내 배포면 도메인을 적으십시오.'));
    }
    if (seeded) {
      console.log(
        '  ' + fill(tr('템플릿 폴더: {0} — 새로 올림 {1} · 이미 있음 {2}'), { 0: templatesDir, 1: seeded.added.length, 2: seeded.skipped.length }),
      );
      for (const item of seeded.failed) console.log(`     [WARN] ${item.name}: ${item.reason}`);
    }
    if (process.env['COLLECT'] === 'on') {
      const seconds = Number(process.env['COLLECT_INTERVAL']);
      console.log(
        Number.isFinite(seconds) && seconds > 0
          ? '  ' + fill(tr('수집(M8) 켜짐 — {0}초마다 자동 수집 · GET /collect-status'), { 0: seconds })
          : '  ' + tr('수집(M8) 켜짐 — POST /packages/{id}/collect (수동). 자동은 COLLECT_INTERVAL=<초>'),
      );
      console.log(
        retentionDays > 0
          ? '     ' + fill(tr('보존 기간 {0}일 — 기동 때 {1}개 정리 · 한 시간마다 반복'), { 0: retentionDays, 1: prunedAtBoot })
          : '     ' + tr('보존 기간 없음(영구 보관) — 오래된 값을 지우려면 COLLECT_RETENTION_DAYS=<일>'),
      );
    } else if (retentionDays > 0) {
      console.log('  ' + fill(tr('수집값 보존 기간 {0}일 — 기동 때 {1}개 정리'), { 0: retentionDays, 1: prunedAtBoot }));
    }

    // OPC UA exposure (M6·M7) — where upstream apps connect.
    // Important: it was refused in demo mode, so **we must not say it is on** (a false log caught in testing)
    if (process.env['OPCUA_SERVER'] === 'on' && bootDemo) {
      console.log('  ' + tr('OPC UA 노출(M6·M7) — **켜지 않았습니다.** 체험 버전에서는 띄우지 않습니다(인증이 없는 포트입니다).'));
    }
    // When OPC UA is on, its lines are printed by the start itself (above) — only once it really runs

    // Integration — say whether events only get recorded or also go out, and where secrets are kept
    const integration = integrationsOf(app);
    if (integration) {
      const services = integration.services;
      if (integration.enabled) {
        console.log('  ' + tr('연동(INTEGRATIONS=on) 켜짐 — 구독한 곳으로 웹훅·MQTT 이벤트를 보냅니다 · GET /integrations/status'));
        const allow = services.egress.allow.map((entry) => entry.text);
        console.log('     ' + (allow.length > 0 ? fill(tr('사내 대상 허용(AAS_INTEGRATION_ALLOW): {0}'), { 0: allow.join(', ') }) : tr('사내 주소로는 보내지 않습니다 — 허용하려면 AAS_INTEGRATION_ALLOW=<CIDR·호스트>')));
      } else {
        console.log('  ' + tr('연동 이벤트는 기록됩니다 · GET /integrations/events — 웹훅·MQTT 전송은 INTEGRATIONS=on'));
        if (process.env['INTEGRATIONS'] === 'on' && bootDemo) console.log('     ' + tr('체험 버전(DEMO_MODE=on)에서는 연동을 켜지 않습니다.'));
      }
      if (services.masterKey === 'missing') {
        console.log('     [WARN] ' + tr('AAS_SECRET_KEY가 없어 웹훅 구독을 만들 수 없습니다 (PostgreSQL). openssl rand -base64 32로 만든 값을 주십시오.'));
      } else if (services.masterKey === 'ephemeral') {
        console.log('     ' + tr('메모리 저장소 — 구독의 서명 비밀값은 서버를 끄면 쓸 수 없게 됩니다.'));
      }
    }

    // Demo mode — the operator must know at startup what is blocked and what gets deleted
    if (bootDemo) {
      console.log('');
      console.log('  [DEMO] ' + tr('체험 버전(DEMO_MODE=on)으로 떴습니다 — 공개해 두고 눌러 보게 하는 구성입니다.'));
      console.log(
        `     ${fill(tr('데모 계정: {0} / {1}  ({2})'), {
          0: bootDemo.login,
          1: bootDemo.password,
          2: demoSeeded === 'created' ? tr('지금 만들었습니다') : demoSeeded === 'updated' ? tr('설정에 맞춰 고쳤습니다') : tr('이미 있습니다'),
        })}`,
      );
      console.log('     ' + tr('이 계정으로는 **파일을 내려받을 수 없습니다.** 가입한 계정은 받을 수 있습니다.'));
      console.log('     ' + tr('작업 공간은 **로그인마다 따로**입니다 — 같은 데모 계정으로 들어와도 서로의 파일을 못 봅니다.'));
      console.log(
        bootDemo.resetMinutes > 0
          ? '     ' + fill(tr('방문자가 {0}분 넘게 손대지 않은 파일은 지웁니다(가입한 사람의 파일은 남깁니다).'), { 0: bootDemo.resetMinutes })
          : '     [WARN] ' + tr('자동 정리가 꺼져 있습니다(AAS_DEMO_RESET_MINUTES=0) — 떠난 방문자의 파일이 계속 쌓입니다.'),
      );
    }
    if (process.env['AAS_WORKSPACE'] === 'private' && !bootDemo) {
      console.log('  [WORKSPACE] ' + tr('작업 공간을 사람마다 나눕니다(AAS_WORKSPACE=private) — 저마다 자기가 올린 것만 봅니다.'));
      console.log('     ' + tr('관리자와 API 키는 전부 봅니다. 그 전에 올려 둔 파일은 모두에게 읽기 전용으로 보입니다.'));
      if (process.env['OPCUA_SERVER'] === 'on' && opcuaModeFromEnv(process.env) === 'insecure') {
        // Important: the OPC UA port has no auth — values kept separate per workspace go out to **anyone** through it
        console.log('     [WARN] ' + tr('OPC UA 노출이 켜져 있습니다 — 그 포트로는 **모든 사람의 값**이 인증 없이 나갑니다.'));
      }
      if (isOpen(bootAuth) && bootUserCount === 0) {
        // Important: without logins there is nothing to separate by — users must not be left believing it is on
        console.log('     [WARN] ' + tr('계정도 API 키도 없어 사람을 구분할 수 없습니다 — 첫 관리자를 만들기 전까지 파일 요청을 받지 않습니다.'));
      }
    }
    if (process.env['AAS_SIGNUP'] === 'on' || bootDemo) {
      const role = process.env['AAS_SIGNUP_ROLE'];
      console.log('  [SIGNUP] ' + fill(tr('스스로 가입할 수 있습니다 — 새 계정의 역할: {0}'), { 0: role === 'viewer' ? 'viewer' : 'editor' }));
      if (role === 'admin') {
        console.log('     [WARN] ' + tr('AAS_SIGNUP_ROLE=admin은 받지 않습니다 — 가입하면 누구나 관리자가 됩니다. editor로 둡니다.'));
      }
    }

    // Setup code for creating the first admin — asked only on externally reachable servers.
    // Important: being able to read the log is proof of "access to the server". That is why it is printed here
    if (setupCodeRequired(bind.protected)) {
      console.log('');
      console.log('  [SETUP] ' + fill(tr('첫 관리자 설치 코드: {0}'), { 0: setupCode(process.env) }));
      console.log('     ' + tr('계정이 하나도 없을 때 「첫 관리자 만들기」 화면이 이 값을 묻습니다.'));
      console.log('     ' + tr('계정을 만들고 나면 쓰이지 않습니다. 직접 정하려면 AAS_SETUP_CODE=<값>.'));
    }

    // Important: it must not be silently open. After deploying in-house, this line is how someone notices
    const configured = bootAuth;
    if (isOpen(configured)) {
      console.log('');
      if (bind.protected) {
        console.log('  [LOCAL] ' + tr('보호 모드 — 토큰이 없어 **이 컴퓨터에서만** 열었습니다 (127.0.0.1).'));
        console.log('     ' + tr('다른 사람도 쓰게 하려면 AAS_TOKEN=<토큰>을 주고 다시 띄우십시오.'));
        console.log('     ' + tr('토큰 없이 밖으로 열려면 AAS_ALLOW_OPEN=1 (권하지 않습니다).'));
      } else if (process.env['AAS_ALLOW_OPEN'] === '1') {
        // Opened deliberately — no reason to repeat the scary warning
        console.log('  [OPEN] ' + tr('토큰 없이 열었습니다 (AAS_ALLOW_OPEN=1) — 같은 망의 누구나 열고 고칠 수 있습니다.'));
        console.log('     ' + tr('특정 사람만 쓰게 하려면 AAS_TOKEN=<토큰>을 주고 다시 띄우십시오.'));
      } else {
        console.log('  [WARN] ' + tr('인증이 꺼진 채 밖으로 열려 있습니다 — 주소를 아는 누구나 파일을 읽고 지울 수 있습니다.'));
        console.log('     ' + tr('AAS_TOKEN=<토큰>으로 띄우십시오.'));
      }
      console.log('     ' + tr('읽기 전용만 줄 때는 AAS_READONLY_TOKEN=<토큰>.'));
    } else {
      console.log(
        '  ' + fill(tr('인증 켜짐 — 전체 토큰 {0}개 · 읽기 전용 {1}개'), { 0: configured.tokens.length, 1: configured.readOnlyTokens.length }),
      );
      // HTTP headers should be ASCII. The server recovers Korean (non-ASCII) tokens,
      // but an intermediate proxy may mangle them again, so warn ahead of time
      const nonAscii = [...configured.tokens, ...configured.readOnlyTokens].filter(
        (token) => !isAsciiToken(token),
      ).length;
      if (nonAscii > 0) {
        console.log(
          '  [WARN] ' + fill(tr('토큰 {0}개에 ASCII 밖 문자가 있습니다 — 영문·숫자·기호로 바꾸기를 권합니다.'), { 0: nonAscii }),
        );
      }
    }
  });
});
