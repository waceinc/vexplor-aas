/**
 * node:http 어댑터.
 *
 * 여기 있는 것은 전송 계층뿐이다 — 본문 읽기, 질의문자열 파싱, 응답 쓰기.
 * 판단은 전부 api.ts 아래에 있어서 테스트가 서버를 띄우지 않고도 전부 돈다.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AasxLimits } from '@aas/aasx';
import type { AuthConfig } from './auth.js';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { parsePolicy, type LinterPolicy } from '@aas/linter';
// 🔴 OPC UA는 **쓸 때 읽는다**(import()). node-opcua는 파일이 수천 개라, PC가 그 파일들을 잊은
//    뒤 처음 켜면 읽기만 30초 넘게 걸렸다(2026-10-06 실측 34초 — 그동안 포트가 안 열려
//    「서버가 죽었다」로 보였다). 저작만 하는 사람은 OPC UA를 한 번도 안 쓴다.
import type { SimulatorServer } from '@aas/opcua';
const opcua = () => import('@aas/opcua');
import { InMemoryStore, visibleInWorkspace, type AasStore } from '@aas/store';
import { createApi, toErrorResponse } from './api.js';
import type { OpcUaPublisher } from './publisher.js';
import { CollectSupervisor } from './supervisor.js';
import { authFromEnv, isAsciiToken, isOpen, resolveBindHost } from './auth.js';
import { ApiError, json, JSON_TYPE, type ApiRequest } from './http.js';
import { isDocumentRequest, openStatic, resolveStatic } from './static.js';
import { seedTemplates } from './templates.js';
import { retentionDaysFromEnv, startRetention } from './retention.js';
import { corsFromEnv, corsHeaders, isPreflight, type CorsPolicy } from './cors.js';
import { demoOutboundAllowed, isHttps, OutboundBlockedError, securityHeaders, setupCode, setupCodeRequired } from './security.js';
import { demoFromEnv, seedDemoUser, startDemoReset } from './demo.js';
import { hashPassword, verifyPassword } from './password.js';

/** 업로드 상한 — Zip Bomb 대비(기획서 Ⅷ 보안 항목). 기본 512MB */
const DEFAULT_MAX_BODY = 512 * 1024 * 1024;

export interface ServerOptions {
  store?: AasStore;
  port?: number;
  maxBodyBytes?: number;
  /** 업로드 AASX 압축 해제 상한. 환경변수 AASX_MAX_TOTAL_MB로도 준다 */
  aasxLimits?: Partial<AasxLimits>;
  /**
   * 수집(M8)을 켤지. 기본은 끔 — 저작만 하는 배포에 OPC UA 스택을 올릴 이유가 없다.
   * 환경변수 `COLLECT=on`으로도 켠다.
   */
  collect?: boolean;
  /** 접근 제어. 주지 않으면 환경변수(AAS_TOKEN·AAS_READONLY_TOKEN)에서 읽는다 */
  auth?: AuthConfig;
  /** 교차 출처 허용. 주지 않으면 환경변수 `CORS_ORIGIN`에서 읽는다. 비어 있으면 CORS 헤더를 내지 않는다 */
  cors?: CorsPolicy;
  /**
   * 저작 UI 빌드 결과(`apps/web/dist`)를 같은 포트에서 내줄지. 환경변수 `WEB_ROOT`로도 준다.
   * 주지 않으면 `apps/web/dist`가 있을 때만 켜진다 — 개발 중(vite 5173)에는 방해하지 않는다.
   */
  webRoot?: string;
}

/**
 * 정책 파일(`AAS_POLICY_FILE`)을 읽는다.
 *
 * 🔴 파일이 있는데 잘못됐으면 **띄우지 않는다.** 정책이 조용히 무시된 채로 도는 것보다
 *    안 뜨는 편이 낫다 — "바꿨는데 안 바뀌었다"를 제출한 뒤에 알면 되돌릴 수 없다.
 */
function policyFromFile(): Partial<LinterPolicy> {
  const path = process.env['AAS_POLICY_FILE'];
  if (!path) return {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`정책 파일을 읽지 못했습니다: ${path} — ${String(error)}`);
  }
  const { policy, changed } = parsePolicy(text);
  console.log(
    `  정책 파일: ${path} — ${changed.length === 0 ? '기본값과 같음' : `바꾼 항목 ${changed.join(', ')}`}`,
  );
  return policy;
}

/** 화면을 어디서 내줄지 — 명시값 > 환경변수 > 있으면 쓰는 기본값 */
function webRootFrom(explicit: string | undefined): string | undefined {
  const chosen = explicit ?? process.env['WEB_ROOT'];
  if (chosen) return resolve(chosen);
  const guess = resolve(process.cwd(), 'apps/web/dist');
  return existsSync(guess) ? guess : undefined;
}

/** 환경변수로 상한을 조절한다 — 배포처마다 메모리가 다르다 */
function limitsFromEnv(): Partial<AasxLimits> | undefined {
  const megabytes = Number(process.env['AASX_MAX_TOTAL_MB']);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return undefined;
  return { maxTotalUncompressedBytes: Math.floor(megabytes * 1024 * 1024) };
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = chunk as Uint8Array;
    size += data.length;
    if (size > limit) {
      throw new ApiError(413, 'PayloadTooLarge', `본문이 상한(${limit} 바이트)을 넘었습니다.`);
    }
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

export async function toApiRequest(
  request: IncomingMessage,
  limit: number,
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

  const raw = await readBody(request, limit);
  const contentType = headers['content-type'] ?? '';
  let body: unknown;
  if (raw.length > 0) {
    // JSON이면 파싱하고, 그 밖(AASX 업로드)은 바이트 그대로 넘긴다
    body = contentType.includes('json') ? JSON.parse(new TextDecoder().decode(raw)) : raw;
  }

  const remote = request.socket.remoteAddress;
  return {
    method: request.method ?? 'GET',
    path: url.pathname,
    query,
    queryAll,
    headers,
    body,
    ...(remote ? { remoteAddress: remote } : {}),
  };
}

export function createHttpServer(options: ServerOptions = {}): Server {
  const store = options.store ?? new InMemoryStore();
  const aasxLimits = options.aasxLimits ?? limitsFromEnv();
  const collect = options.collect ?? process.env['COLLECT'] === 'on';
  // 규정 충돌 선택을 배포 단위로 정한다. 개별 요청은 질의 인자로 덮어쓸 수 있다
  const standardTerms = process.env['LINT_STANDARD_TERMS'];
  const policy: Partial<LinterPolicy> = {
    // 🔴 정책 파일이 먼저다. 규약이 바뀌면 코드를 고치지 않고 파일을 고친다
    ...policyFromFile(),
    ...(standardTerms === 'preserve' || standardTerms === 'kosmo-first'
      ? { standardTemplateSemantics: standardTerms }
      : {}),
  };
  const auth = options.auth ?? authFromEnv(process.env);
  const cors = options.cors ?? corsFromEnv(process.env);
  const publicBaseUrl = process.env['AAS_PUBLIC_URL'];
  // 체험판 여부는 아래 여러 곳이 본다(OPC UA 거절·내려받기 차단·가입) — 먼저 읽어 둔다
  const demo = demoFromEnv(process.env);
  const simulatorPort = Number(process.env['SIMULATOR_PORT'] ?? 14850);
  /** 체험판이면 가상 PLC 말고는 밖으로 접속하지 않는다(SSRF 차단 — security.ts) */
  const guardOutbound = (endpoint: string): void => {
    if (demo && !demoOutboundAllowed(endpoint, simulatorPort)) throw new OutboundBlockedError();
  };

  /** AID가 말한 주소로 붙는다. 프로토콜을 아는 곳은 @aas/opcua 하나뿐이다 */
  const openReader = async (descriptor: AidInterface): Promise<ProtocolReader> => {
    if (descriptor.protocol !== 'OPCUA') {
      throw new Error(`아직 지원하지 않는 프로토콜입니다: ${descriptor.protocol}`);
    }
    if (!descriptor.base) throw new Error('EndpointMetadata.base가 없습니다.');
    guardOutbound(descriptor.base);
    return (await opcua()).OpcUaReader.connect({ endpoint: descriptor.base });
  };

  /**
   * 내장 가상 PLC(시뮬레이션) — 설치판만 가진 평가자가 번들을 재현하는 길. 수집이 켜진 서버에서만,
   * 처음 「가상 PLC로 연결」을 누를 때 뜬다(포트 SIMULATOR_PORT, 기본 14850)
   */
  let simulator: Promise<SimulatorServer> | undefined;
  const simulatorOnce = (): Promise<SimulatorServer> =>
    // 약속을 들고 있는다 — 두 번 겹쳐 눌러도 가상 PLC는 하나만 뜬다
    (simulator ??= opcua().then(
      ({ SimulatorServer: Simulator }) => new Simulator({ port: simulatorPort }),
    ));

  /**
   * 상시 주기 수집. `COLLECT=on` + `COLLECT_INTERVAL=<초>`일 때만 돈다 —
   * 저작만 하는 배포에서 장비를 주기적으로 두드릴 이유가 없다.
   */
  const intervalSeconds = Number(process.env['COLLECT_INTERVAL']);
  let supervisor: CollectSupervisor | undefined;
  if (collect && Number.isFinite(intervalSeconds) && intervalSeconds > 0) {
    supervisor = new CollectSupervisor({ store, openReader, intervalMs: intervalSeconds * 1000 });
    supervisor.start();
  }

  /**
   * OPC UA 노출 — 기획서 M6·M7. 「저작 도구 자체가 OPC UA 서버가 된다」(기획서 Ⅱ-3).
   *
   * 🔴 기본은 꺼져 있다. 켜면 **인증 없는 포트가 하나 더 열린다** — HTTP의 토큰 인증과
   *    성격이 달라서, 여는 것은 배포자가 명시적으로 정해야 한다.
   */
  /**
   * 🔴 **체험판에서는 띄우지 않는다.** OPC UA 노출 포트에는 아직 인증이 없다.
   *    사내망이면 「망 안에서만 보인다」가 방어지만, 체험판은 **공개해 두는 서버**라
   *    그 전제가 통째로 깨진다. 둘을 함께 켠 것은 실수일 가능성이 높으니 거절하고 알린다.
   */
  if (demo && process.env['OPCUA_SERVER'] === 'on') {
    console.error('  ⚠️  체험판(DEMO_MODE=on)에서는 OPC UA 노출을 켜지 않습니다 — 그 포트에는 인증이 없습니다.');
  }
  const publishing = process.env['OPCUA_SERVER'] === 'on' && !demo;
  let publisher: OpcUaPublisher | undefined;
  if (publishing) {
    // 서버가 안 서도 저작 기능은 살아야 한다 — 사유만 남기고 계속한다
    void import('./publisher.js')
      .then(({ OpcUaPublisher: Publisher }) => {
        publisher = new Publisher({
          store,
          port: Number(process.env['OPCUA_PORT'] ?? 4840),
          refreshMs: Math.max(1, Number(process.env['OPCUA_REFRESH'] ?? 5)) * 1000,
          ...(process.env['OPCUA_HOST'] ? { hostname: process.env['OPCUA_HOST'] } : {}),
        });
        return publisher.start();
      })
      .catch((error: unknown) => {
      console.error(
        `  ⚠️  OPC UA 서버를 띄우지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  // 🔴 밖으로 열린 서버에서는 첫 관리자를 **아무나 선점하지 못하게** 설치 코드를 묻는다.
  //    이 컴퓨터에서만 열린 서버(보호 모드)는 묻지 않는다 — 서버 앞에 앉은 사람이다
  const needsSetupCode = setupCodeRequired(resolveBindHost(process.env, auth).protected);

  // 가입은 기본으로 **닫혀 있다**. 체험 서버는 가입이 있어야 뜻이 서므로 함께 열린다
  // 🔴 스스로 가입한 사람은 **관리자가 될 수 없다.** AAS_SIGNUP_ROLE=admin을 받아 주면 가입 단추가
  //    곧 관리자 발급 단추가 된다 — 계정 관리·작업 공간 전부 보기·남의 계정 잠그기까지 열린다.
  //    관리자는 관리자가 「설정 → 계정 관리」에서 올려 준다
  const signupRole: 'editor' | 'viewer' = process.env['AAS_SIGNUP_ROLE'] === 'viewer' ? 'viewer' : 'editor';
  // 🔴 처리방침 주소가 없으면 연락처를 **받지 않는다.** 어떻게 쓰는지 밝히지 않고
  //    개인정보를 모으지 않겠다는 뜻이다(routes/auth.ts)
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
    ...(demo ? { demo } : {}),
    ...(signup ? { signup } : {}),
    // 작업 공간을 사람마다 나눌지. 체험판은 createApi가 알아서 켠다
    ...(process.env['AAS_WORKSPACE'] === 'private' ? { privateWorkspaces: true } : {}),
    ...(needsSetupCode ? { setupCode: setupCode(process.env) } : {}),
    // 쿠키 세션으로 들어온 쓰기는 원점을 따진다(security.ts). 허용한 교차 출처는 통과시킨다
    corsOrigins: cors.origins,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    routes: [
      {
        /** 밖으로 무엇을 내주고 있는지 — 화면·운영자가 확인하는 자리 */
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
                  reason: publishing ? 'OPC UA 서버를 띄우는 중입니다.' : 'OPCUA_SERVER=on이 아닙니다.',
                },
          ),
      },
      {
        /** "돌고는 있는 건가"에 답하는 자리 — 마지막 주기의 결과 */
        method: 'GET',
        pattern: '/collect-status',
        handle: async () => {
          if (!supervisor) {
            return json(200, {
              // collect — 수집(과 가상 PLC)을 쓸 수 있는 서버인가. 화면이 버튼을 보일지 여기서 정한다
              collect,
              running: false,
              reason: 'COLLECT_INTERVAL이 설정되지 않았습니다 (수동 수집만).',
            });
          }
          const status = supervisor.status();
          // 🔴 지난 주기의 결과는 **모든 패키지**를 돈 것이다(서버 자신이 돌린다). 그대로 내주면
          //    작업 공간을 나누는 서버에서 남의 파일 이름과 설비 주소가 보인다.
          //    저장소 겹이 거르지 못하는 「미리 모아 둔 것」이라 내주는 자리에서 직접 거른다
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
            title: (await opcua()).SIMULATOR_TITLE,
          }),
        }
      : {}),
    // 🔴 훑기는 수집이 꺼져 있어도 쓸 수 있어야 한다 — AID를 **만들 때** 필요한 기능이다.
    //    우리 서버의 신원을 함께 넘겨 **자기 자신을 훑는 사고**를 막는다.
    browseDevice: async (endpoint: string) => {
      guardOutbound(endpoint);
      const self = publisher?.status().instanceUri;
      return (await opcua()).browseDevice({ endpoint, ...(self ? { selfUri: self } : {}) });
    },
  });
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const webRoot = webRootFrom(options.webRoot);
  let ready: Promise<void> | undefined;

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try {
        // 정적 파일이 먼저다. 실제로 있는 파일일 때만 가로채므로 API 경로와 부딪히지 않는다.
        // 🔴 여기에는 인증을 걸지 않는다 — 화면이 떠야 사용자가 토큰을 넣을 수 있다
        // 응답마다 붙는 보안 머리글. 🔴 **정적 파일에도 붙여야 한다** — CSP가 지키는 것은
        // 다름 아닌 그 화면이다. API 응답에만 붙이면 정작 앱 페이지가 무방비다
        const guard = securityHeaders(isHttps(request.headers, (request.socket as { encrypted?: boolean }).encrypted === true));

        if (webRoot && (request.method === 'GET' || request.method === 'HEAD')) {
          const path = new URL(request.url ?? '/', 'http://localhost').pathname;
          const asset = await resolveStatic(webRoot, path);
          if (asset) {
            writeFile(request, response, asset, guard);
            return;
          }
        }

        // 교차 출처 — 허용된 Origin일 때만 헤더가 붙는다. 사전 요청은 인증 전에 답해야
        // 브라우저가 본 요청을 보낼 수 있다(토큰은 본 요청에 실려 온다)
        const corsExtra = corsHeaders(cors, request.headers.origin);
        if (isPreflight(request.method ?? '', request.headers)) {
          write(response, Object.keys(corsExtra).length > 0 ? 204 : 403, { ...guard, ...corsExtra }, undefined);
          return;
        }

        ready ??= store.init();
        await ready;
        const apiRequest = await toApiRequest(request, limit);
        const apiResponse = await handle(apiRequest);

        // API가 모르는 경로인데 브라우저가 화면을 달라고 한 것이면 앱 껍데기를 준다
        // (새로고침·즐겨찾기). API 요청(JSON)에는 404·401을 그대로 돌려준다.
        // 401도 함께 보는 이유: 인증을 켜면 경로 대조보다 인가가 먼저라 없는 경로도 401이 된다.
        // 껍데기는 어차피 누구나 받을 수 있는 것이므로 여기서 내줘도 새는 것이 없다
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
        write(response, fallback.status, fallback.headers, fallback.body);
      }
    })();
  });
}

/** 파일은 통째로 읽지 않고 흘려 보낸다 — 큰 파일에서 메모리를 두 배로 쓰지 않기 위해서다 */
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
 * 보관함 고르기 — 셋 중 하나.
 *
 *  ① `DATABASE_URL`   PostgreSQL. 여러 명이 함께 쓰고 수집값을 오래 쌓을 때(배포 구성)
 *  ② `AAS_DATA_DIR`   그 폴더에 파일로. **혼자 쓸 때 — Docker가 필요 없다**
 *  ③ 둘 다 없으면      메모리. 서버를 끄면 사라진다(시연·개발)
 *
 * 🔴 ②를 만든 이유는 설치를 쉽게 하기 위해서다. "파일이 남게 하려면 데이터베이스를 띄우십시오"가
 *    혼자 쓰는 사람에게 과했다(2026-08-25 사용자). 어느 것을 쓰는지 기동 로그에 적는다.
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
  const { connectPostgres } = await import('./pg.js');
  const schema = process.env['DATABASE_SCHEMA'];
  const { store, timescale } = await connectPostgres({
    connectionString: url,
    ...(schema ? { schema } : {}),
  });
  return { store, kind: `postgres${schema ? ` (schema ${schema})` : ''} · 수집값 ${timescale}` };
}

/** `node dist/server.js`로 바로 띄운다 */
if (process.argv[1]?.endsWith('server.js')) {
  const port = Number(process.env['PORT'] ?? 8080);
  const { store: bootStore, kind } = await storeFromEnv();
  // 템플릿 폴더(선택) — 「다른 파일에서 가져오기」의 출처가 되는 AASX를 미리 올려 둔다
  const templatesDir = process.env['AAS_TEMPLATES_DIR'];
  const seeded = templatesDir ? await seedTemplates(bootStore, templatesDir, limitsFromEnv()) : undefined;
  // 수집값 보존 기간(선택) — 기동 때 한 번 지우고, 그 뒤 한 시간마다
  const retentionDays = retentionDaysFromEnv(process.env);
  const retention = startRetention(bootStore, retentionDays);
  const prunedAtBoot = await retention.pruneNow().catch((error: unknown) => {
    console.error(`  ⚠️  수집값 정리 실패: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  });
  // 체험판 — 계정을 심고, 올린 것을 주기적으로 비운다(demo.ts)
  const bootDemo = demoFromEnv(process.env);
  const demoSeeded = bootDemo ? await seedDemoUser(bootStore, bootDemo, hashPassword, verifyPassword) : undefined;
  if (bootDemo) startDemoReset(bootStore, bootDemo.resetMinutes, (line) => console.log(`  ${line}`));

  const bootAuth = authFromEnv(process.env);
  const bootUserCount = await bootStore.countUsers();
  const bind = resolveBindHost(process.env, bootAuth);
  const app = createHttpServer({ port, store: bootStore });

  // 🔴 윈도우에서 `localhost`는 IPv6(::1)로 먼저 풀린다. 보호 모드는 IPv4(127.0.0.1)에만
  //    물리므로 브라우저가 "연결할 수 없음"을 낸다(실측: 윈도우 앱판에서 페이지가 안 떴다).
  //    같은 처리기를 IPv6 루프백에도 하나 더 물려 둔다 — 밖으로 열리는 것은 아니다.
  //    안 되는 환경(IPv6 꺼짐)도 있으므로 실패는 그냥 넘긴다.
  if (bind.protected) {
    const handler = app.listeners('request')[0] as Parameters<typeof createServer>[0];
    const twin = createServer(handler);
    twin.on('error', () => undefined);
    twin.listen(port, '::1');
  }

  app.listen(port, bind.host, () => {
    console.log(`AAS API가 http://localhost:${port} 에서 대기합니다.`);
    console.log(`  Part 2 기저 경로: /packages/{packageId}/api/v3.0`);
    console.log(`  저장소: ${kind}`);
    if (kind === 'memory') {
      console.log('     ⚠️  서버를 끄면 올린 파일이 사라집니다.');
      console.log('        남기려면 AAS_DATA_DIR=<폴더> (혼자 쓸 때) 또는 DATABASE_URL (여럿이 쓸 때).');
    } else if (kind.startsWith('folder')) {
      console.log('     껐다 켜도 남습니다. 그 폴더를 통째로 복사하면 그대로 옮겨집니다.');
    }
    const root = webRootFrom(undefined);
    console.log(root ? `  저작 UI: 같은 포트에서 내줍니다 (${root})` : '  저작 UI: 없음 (API만)');
    const corsOrigins = corsFromEnv(process.env).origins;
    if (corsOrigins.length > 0) {
      console.log(`  교차 출처(CORS) 허용: ${corsOrigins.join(', ')}`);
      if (corsOrigins.includes('*')) console.log('     ⚠️  모든 출처에 열려 있습니다 — 사내 배포면 도메인을 적으십시오.');
    }
    if (seeded) {
      console.log(
        `  템플릿 폴더: ${templatesDir} — 새로 올림 ${seeded.added.length} · 이미 있음 ${seeded.skipped.length}`,
      );
      for (const item of seeded.failed) console.log(`     ⚠️  ${item.name}: ${item.reason}`);
    }
    if (process.env['COLLECT'] === 'on') {
      const seconds = Number(process.env['COLLECT_INTERVAL']);
      console.log(
        Number.isFinite(seconds) && seconds > 0
          ? `  수집(M8) 켜짐 — ${seconds}초마다 자동 수집 · GET /collect-status`
          : '  수집(M8) 켜짐 — POST /packages/{id}/collect (수동). 자동은 COLLECT_INTERVAL=<초>',
      );
      console.log(
        retentionDays > 0
          ? `     보존 기간 ${retentionDays}일 — 기동 때 ${prunedAtBoot}개 정리 · 한 시간마다 반복`
          : '     보존 기간 없음(영구 보관) — 오래된 값을 지우려면 COLLECT_RETENTION_DAYS=<일>',
      );
    } else if (retentionDays > 0) {
      console.log(`  수집값 보존 기간 ${retentionDays}일 — 기동 때 ${prunedAtBoot}개 정리`);
    }

    // OPC UA 노출(M6·M7) — 상위 앱이 붙는 자리.
    // 🔴 체험판에서는 거절했으므로 **켜졌다고 말하면 안 된다**(실측으로 잡은 거짓 로그)
    if (process.env['OPCUA_SERVER'] === 'on' && bootDemo) {
      console.log('  OPC UA 노출(M6·M7) — 🔴 **켜지 않았습니다.** 체험판에서는 띄우지 않습니다(인증이 없는 포트입니다).');
    } else if (process.env['OPCUA_SERVER'] === 'on') {
      const uaPort = Number(process.env['OPCUA_PORT'] ?? 4840);
      const every = Math.max(1, Number(process.env['OPCUA_REFRESH'] ?? 5));
      console.log(`  OPC UA 노출(M6·M7) 켜짐 — opc.tcp://<이 서버>:${uaPort}/UA/AAS · ${every}초마다 갱신`);
      console.log('     상위 앱(MES·SCADA)이 구독으로 값을 받아 갑니다 · GET /opcua-status');
      // 🔴 여기서 한 번은 말해야 한다 — HTTP는 토큰으로 막혀 있어도 이쪽은 아니다
      console.log('     ⚠️  이 포트에는 인증이 없습니다. 사내망 밖으로 열지 마십시오.');
    }

    // 체험판 — 무엇이 막혀 있고 무엇이 지워지는지 운영자가 기동할 때 알아야 한다
    if (bootDemo) {
      console.log('');
      console.log('  🧪 체험판(DEMO_MODE=on)으로 떴습니다 — 공개해 두고 눌러 보게 하는 구성입니다.');
      console.log(
        `     데모 계정: ${bootDemo.login} / ${bootDemo.password}  (${demoSeeded === 'created' ? '지금 만들었습니다' : demoSeeded === 'updated' ? '설정에 맞춰 고쳤습니다' : '이미 있습니다'})`,
      );
      console.log('     이 계정으로는 **파일을 내려받을 수 없습니다.** 가입한 계정은 받을 수 있습니다.');
      console.log('     작업 공간은 **로그인마다 따로**입니다 — 같은 데모 계정으로 들어와도 서로의 파일을 못 봅니다.');
      console.log(
        bootDemo.resetMinutes > 0
          ? `     방문자가 ${bootDemo.resetMinutes}분 넘게 손대지 않은 파일은 지웁니다(가입한 사람의 파일은 남깁니다).`
          : '     🔴 자동 정리가 꺼져 있습니다(AAS_DEMO_RESET_MINUTES=0) — 떠난 방문자의 파일이 계속 쌓입니다.',
      );
    }
    if (process.env['AAS_WORKSPACE'] === 'private' && !bootDemo) {
      console.log('  🗂  작업 공간을 사람마다 나눕니다(AAS_WORKSPACE=private) — 저마다 자기가 올린 것만 봅니다.');
      console.log('     관리자와 API 키는 전부 봅니다. 그 전에 올려 둔 파일은 모두에게 읽기 전용으로 보입니다.');
      if (process.env['OPCUA_SERVER'] === 'on') {
        // 🔴 OPC UA 포트에는 인증이 없다 — 나눠 놓은 값이 그 포트로는 **누구에게나** 나간다
        console.log('     ⚠️  OPC UA 노출이 켜져 있습니다 — 그 포트로는 **모든 사람의 값**이 인증 없이 나갑니다.');
      }
      if (isOpen(bootAuth) && bootUserCount === 0) {
        // 🔴 로그인이 없으면 가를 기준이 없다 — 켰다고 믿게 두면 안 된다
        console.log('     ⚠️  계정도 API 키도 없으면 가를 수 없습니다 — 모두가 같은 칸을 씁니다. 계정을 먼저 만드십시오.');
      }
    }
    if (process.env['AAS_SIGNUP'] === 'on' || bootDemo) {
      const role = process.env['AAS_SIGNUP_ROLE'];
      console.log(`  ✍️  스스로 가입할 수 있습니다 — 새 계정의 역할: ${role === 'viewer' ? 'viewer' : 'editor'}`);
      if (role === 'admin') {
        console.log('     ⚠️  AAS_SIGNUP_ROLE=admin은 받지 않습니다 — 가입하면 누구나 관리자가 됩니다. editor로 둡니다.');
      }
    }

    // 첫 관리자를 만들 때 쓸 설치 코드 — 밖으로 열린 서버에서만 묻는다.
    // 🔴 로그를 볼 수 있다는 것이 「서버를 만질 수 있다」는 증거다. 그래서 여기에 찍는다
    if (setupCodeRequired(bind.protected)) {
      console.log('');
      console.log(`  🔑 첫 관리자 설치 코드: ${setupCode(process.env)}`);
      console.log('     계정이 하나도 없을 때 「첫 관리자 만들기」 화면이 이 값을 묻습니다.');
      console.log('     계정을 만들고 나면 쓰이지 않습니다. 직접 정하려면 AAS_SETUP_CODE=<값>.');
    }

    // 🔴 조용히 열려 있으면 안 된다. 사내에 올린 뒤 이 줄을 보고 알아채야 한다
    const configured = bootAuth;
    if (isOpen(configured)) {
      console.log('');
      if (bind.protected) {
        console.log('  🔒 보호 모드 — 토큰이 없어 **이 컴퓨터에서만** 열었습니다 (127.0.0.1).');
        console.log('     다른 사람도 쓰게 하려면 AAS_TOKEN=<토큰>을 주고 다시 띄우십시오.');
        console.log('     토큰 없이 밖으로 열려면 AAS_ALLOW_OPEN=1 (권하지 않습니다).');
      } else if (process.env['AAS_ALLOW_OPEN'] === '1') {
        // 스스로 정하고 연 것이다 — 겁주는 문구를 반복할 이유가 없다
        console.log('  🔓 토큰 없이 열었습니다 (AAS_ALLOW_OPEN=1) — 같은 망의 누구나 열고 고칠 수 있습니다.');
        console.log('     특정 사람만 쓰게 하려면 AAS_TOKEN=<토큰>을 주고 다시 띄우십시오.');
      } else {
        console.log('  ⚠️  인증이 꺼진 채 밖으로 열려 있습니다 — 주소를 아는 누구나 파일을 읽고 지울 수 있습니다.');
        console.log('     AAS_TOKEN=<토큰>으로 띄우십시오.');
      }
      console.log('     읽기 전용만 줄 때는 AAS_READONLY_TOKEN=<토큰>.');
    } else {
      console.log(
        `  인증 켜짐 — 전체 토큰 ${configured.tokens.length}개 · 읽기 전용 ${configured.readOnlyTokens.length}개`,
      );
      // HTTP 헤더는 ASCII가 원칙이다. 한글 토큰은 서버가 되돌려 맞춰 주지만
      // 중간 프록시가 또 건드릴 수 있어 미리 알린다
      const nonAscii = [...configured.tokens, ...configured.readOnlyTokens].filter(
        (token) => !isAsciiToken(token),
      ).length;
      if (nonAscii > 0) {
        console.log(
          `  ⚠️  토큰 ${nonAscii}개에 ASCII 밖 문자가 있습니다 — 영문·숫자·기호로 바꾸기를 권합니다.`,
        );
      }
    }
  });
}
