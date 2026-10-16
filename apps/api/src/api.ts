/**
 * API assembly — routing and error conversion.
 *
 * Gathered here so that this is the only place that maps store errors (NotFound, Conflict, InvalidContent)
 * to HTTP statuses. Handlers can simply throw domain errors.
 */
import { fill, PRODUCT_VERSION, tr } from '@aas/core';
import {
  ConflictError,
  ExternalRefConflictError,
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
  runAsActor,
  runInWorkspace,
  runWithChange,
  scopeStore,
  type AasStore,
  type Actor,
  type Workspace,
} from '@aas/store';
import { AasxLimitError, AasxReadError } from '@aas/aasx';
import { ValueNotSupportedError } from './elements.js';
import { ApiError, errorResponse, ServiceBusyError, json, type ApiRequest, type ApiResponse } from './http.js';
import { authorize, fullTokenGiven, isAlwaysOpen, isOpen, OPEN_ACCESS, type AuthResult, type Principal } from './auth.js';
import { buildAuthRoutes, principalOf } from './routes/auth.js';
import { LoginThrottle, SessionStore } from './session.js';
import { crossSiteWrite, isHttps } from './security.js';
import { isFileDownload, VISITOR_PREFIX, type DemoConfig } from './demo.js';
import { compile, match, type Route } from './router.js';
import { createEdgeHandler, edgeError } from './edge/routes-edge.js';
import { edgeAdminRoutes } from './edge/routes-edge-admin.js';
import { EdgeRegistry } from './edge/state.js';
import { hasIntegrationStore } from './integration/exports/store.js';

const DEFAULT_EDGE_INTERVAL_MS = 5000;
import { registryRoutes } from './routes/registry.js';
import { packageRoutes } from './routes/packages.js';
import { bundleRoutes } from './routes/bundle.js';
import { requirementRoutes } from './routes/requirements.js';
import { DERIVATION_PART, derivationRoutes } from './routes/derivation.js';
import { AASX_FILE_SERVER_PROFILES, descriptionRoute, part2Routes } from './routes/part2.js';
import { describeChange, UndoStack } from './undo.js';
import { langOf, runInLang } from './lang.js';
import { integrationRoutes } from './integration/routes.js';
import { changeContextFor } from './integration/change-context.js';

export type { ApiOptions } from './api-options.js';
import type { ApiOptions } from './api-options.js';

/**
 * The full route table.
 *
 * It is exported for spec cross-checking — scripts/part2-coverage.mjs compares this table
 * against the IDTA Part 2 original text (docs/spec/part2/). Adding or removing routes moves that comparison along.
 */
export function buildRoutes(store: AasStore, options: ApiOptions = {}): Route[] {
  return [
    ...buildAuthRoutes(store, {
      sessions: options.sessions ?? new SessionStore(),
      // Shared with the OPC UA account check when the server passes one (server.ts) — one guessing cap per account
      throttle: options.loginThrottle ?? new LoginThrottle(),
      // Look at X-Forwarded-Proto set by the proxy. Attaching Secure for someone connecting over plain HTTP
      // makes the browser drop the cookie, so login fails entirely
      secureCookie: options.secureCookie ?? ((request) => isHttps(request.headers, false)),
      tokenAuth: !isOpen(options.auth ?? OPEN_ACCESS),
      ...(options.setupCode === undefined ? {} : { setupCode: options.setupCode }),
      ...(options.signup ? { signup: options.signup } : {}),
      ...(options.signupThrottle ? { signupThrottle: options.signupThrottle } : {}),
      ...(options.demo ? { demo: { login: options.demo.login, password: options.demo.password } } : {}),
      hasFullKey: (request) => fullTokenGiven(options.auth ?? OPEN_ACCESS, request),
    }),
    ...packageRoutes(store, {
      ...(options.aasxLimits ? { aasxLimits: options.aasxLimits } : {}),
      ...(options.openReader ? { openReader: options.openReader } : {}),
      ...(options.browseDevice ? { browseDevice: options.browseDevice } : {}),
      ...(options.simulate ? { simulate: options.simulate } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
    }),
    ...bundleRoutes(store, {
      ...(options.aasxLimits ? { aasxLimits: options.aasxLimits } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
    }),
    // Template requirement levels (mandatory, optional) — used by the value table
    ...requirementRoutes(store),
    // Type -> unit propagation (files created by splitting per unit)
    ...derivationRoutes(store),
    // The root is the base address of the AASX file server interface
    descriptionRoute('/description', AASX_FILE_SERVER_PROFILES),
    ...part2Routes(store),
    // Registry and discovery — server-wide (everything this server holds, not a single file)
    ...registryRoutes(store, options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    // MES / ERP / CMMS integration — event feed, subscriptions, exports, runtime data (integration/routes.ts)
    ...integrationRoutes(store, {
      demo: options.demo !== undefined,
      ...(options.integration ? { runtime: options.integration } : {}),
      ...(options.integrationServices ? { services: options.integrationServices } : {}),
      ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
      ...(options.collectIntervalMs ? { collectIntervalMs: options.collectIntervalMs } : {}),
      ...(options.integrationAuditStore ? { auditStore: options.integrationAuditStore } : {}),
    }, options.integrationRouteBuilders),
    // Remote collectors — management for people; the signed edge endpoints are answered in createApi
    ...(options.edgeRegistry
      ? edgeAdminRoutes({ registry: options.edgeRegistry, store, intervalMs: options.edge?.intervalMs ?? DEFAULT_EDGE_INTERVAL_MS })
      : []),
    ...(options.routes ?? []),
    ...undoRoutes(options.undo ?? new UndoStack(store)),
    {
      method: 'GET',
      pattern: '/health',
      // Do not hide that authentication is off — this is where it is checked after going into production
      // Include the version number — with multiple deployments, "which version" is the first question in any inquiry
      handle: async () =>
        json(200, {
          status: 'ok',
          version: PRODUCT_VERSION,
          // Important: even without a key, login is required if accounts exist — saying "off" would mislead both operators and attackers
          // Important: kept public on purpose (red-team D3 review, 2026-10-16). The UI reads `version` before sign-in, the
          //    Docker healthcheck and docs read this route, and whether login is required is public anyway — /auth/me must
          //    say it so the UI knows whether to show the login screen. Hiding it here would hide nothing
          auth: isOpen(options.auth ?? OPEN_ACCESS) && (await store.countUsers()) === 0 ? 'off' : 'on',
        }),
    },
  ];
}

/** Whether the request can change the model — decides whether to take an undo snapshot */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UNDO_PATTERNS = new Set(['/packages/:packageId/undo', '/packages/:packageId/redo']);
/** Requests that change sidecar files along with the model — undo snapshots the sidecar files too (undo.ts) */
const SIDECAR_PATTERNS = new Set(['/packages/:packageId/derivation/apply']);
/**
 * Requests that are not undoable and end the package's undo history.
 * External refs live in a store document the snapshot does not hold, while their projection changes the shell: undoing
 * would restore the shell and leave the document saying `publish: true`. Older snapshots predate the projection, so
 * they are dropped too — otherwise undoing an earlier edit would silently remove published ids (review L9).
 */
const UNDO_BARRIER_PATTERNS = new Set(['/packages/:packageId/external-refs']);

export function createApi(base: AasStore, options: ApiOptions = {}): (request: ApiRequest) => Promise<ApiResponse> {
  // Important: wrap the store in a workspace layer. Routes see **only this layer** — if even one route held
  //    the raw store, other people's files would leak through it. Without a context set up (a server that does not
  //    partition) this layer does nothing
  // The demo **always** partitions — many enter with the same account, and without partitioning they see each other's files
  const privateWorkspaces = options.privateWorkspaces === true || options.demo !== undefined;
  const quota = options.maxPackagesPerOwner ?? 50;
  const store = scopeStore(base, privateWorkspaces && quota > 0 ? { maxPackagesPerOwner: quota } : {});
  // Type propagation also changes the type copy (sidecar file) — it must be rolled back together on undo (undo.ts)
  const undo = new UndoStack(store, undefined, [DERIVATION_PART]);
  // Important: routes and request handling must see **the same session table** — separate ones mean login won't work
  const sessions = options.sessions ?? new SessionStore();
  // Remote collectors (edge/): off unless configured, never in demo mode, and only on a store that keeps runtime state
  const edgeRegistry = options.edge && !options.demo && hasIntegrationStore(base) ? new EdgeRegistry(base) : undefined;
  const edge = edgeRegistry
    ? createEdgeHandler({
        registry: edgeRegistry,
        store,
        serverVersion: PRODUCT_VERSION,
        ...(options.edge?.limits ? { limits: options.edge.limits } : {}),
        ...(options.edge?.pollSeconds ? { pollSeconds: options.edge.pollSeconds } : {}),
      })
    : undefined;
  // Audit events go to the unscoped store — a workspace may not write the server log itself (integration/deps.ts)
  const routes = compile(buildRoutes(store, { ...options, sessions, undo, integrationAuditStore: base, ...(edgeRegistry ? { edgeRegistry } : {}) }));

  const auth = options.auth ?? OPEN_ACCESS;
  /**
   * Whether accounts exist — once true, never asked again (the last admin cannot be deleted).
   * A server with a key never opens anyway, so it doesn't ask.
   */
  let accountsExist = false;
  const accountsNow = async (): Promise<boolean> => {
    if (!accountsExist && isOpen(auth)) accountsExist = (await store.countUsers()) > 0;
    return accountsExist;
  };

  // Important: set the language at the very outside — even auth rejections and unknown-path errors go out in the request's language (lang.ts)
  return (request: ApiRequest): Promise<ApiResponse> => runInLang(langOf(request), () => handle(request));

  async function handle(request: ApiRequest): Promise<ApiResponse> {
    // Important: the edge's signature is its identity — answered before the login / API-key check, which an edge
    //    cannot pass (edge/routes-edge.ts). Only when edge is on; otherwise these paths fall through to a 404
    if (edge && request.path.startsWith('/edge/v1/')) {
      try {
        return await edge(request);
      } catch (error) {
        const answer = toErrorResponse(error);
        return answer.status >= 500 ? edgeError(500, 'ServerError', tr('서버 오류입니다 — 같은 묶음을 다시 보내십시오.')) : answer;
      }
    }
    // Important: logged-in people first, machine API keys after (the order design in auth.ts).
    //    With no session, undefined is passed, and then tokens are checked as before.
    const principal = await principalOf(store, sessions, request);
    // Important: CSRF — only **writes** arriving via cookie have their origin checked. The risk comes from the browser
    //    attaching cookies on its own; API keys cannot be attached by another site, so they are not affected
    if (principal) {
      const blocked = crossSiteWrite(request, options.corsOrigins ?? []);
      if (blocked) return blocked;
    }
    // Block **before** matching the path. Reduces probing tokens against nonexistent paths
    const allowed = authorize(auth, request, principal, principal ? true : await accountsNow());
    if (!allowed.ok) return allowed.response!;
    // Important: separating workspaces needs a way to tell people apart. With no accounts and no keys everyone is
    //    "anonymous" and would silently share one workspace while believing it private (red-team L10, 2026-10-16).
    //    Refuse until the first admin exists — the account routes stay open so that can happen
    if (privateWorkspaces && allowed.via === 'open' && !isAlwaysOpen(request.path)) {
      return errorResponse(
        403,
        'Forbidden',
        tr('이 서버는 작업 공간을 사람마다 나눕니다(AAS_WORKSPACE=private) — 먼저 첫 관리자 계정을 만드십시오.'),
      );
    }
    // Some places in routes need to know "who called" (account management, audit records).
    // Important: this is the only place it is resolved — if routes resolved it again themselves, the two interpretations would diverge
    const access = { level: allowed.level ?? 'read-only', via: allowed.via ?? 'open' } as const;
    const inbound: ApiRequest = principal ? { ...request, principal, access } : { ...request, access };

    const found = match(routes, inbound.method, inbound.path);
    if (found === undefined) {
      return errorResponse(404, 'NotFound', fill(tr('경로가 없습니다: {0} {1}'), { 0: request.method, 1: request.path }));
    }
    if (found === 'method-not-allowed') {
      return errorResponse(405, 'MethodNotAllowed', fill(tr('허용되지 않는 메서드입니다: {0}'), { 0: request.method }));
    }

    // Set "who" **only once, here**. Routes and the store pick it up without parameters —
    // threading it through thirty call sites means missing just one leaves that change unrecorded (actor.ts)
    const actor = actorOf(principal, allowed);
    // "Through whose eyes the store is viewed" is also set only once, here. Servers that don't partition don't set it
    const workspace = privateWorkspaces ? workspaceOf(principal, allowed, options.demo) : undefined;
    // "Why it changed" (edit, undo, fix, import …) is set here too, once — model events carry it (integration/change-context.ts)
    const change = changeContextFor(request.method, found.route.pattern);
    return runInWorkspace(workspace, () => runWithChange(change, () => runAsActor(actor, async () => {
      try {
        // Undo — requests that can change the model snapshot the prior state, and push it only when something actually changed.
        // Undo requests themselves are exempt (they move the stack themselves). Deleting a package discards the stack
        const packageId = found.params['packageId'];
        // Important: for requests with a package in the URL, first check **whether that package is visible** (only on partitioning servers).
        //    The store layer blocks most cases, but some things are held by package id **outside** the store —
        //    the undo list is one (server memory). Through that path one could read someone else's list, and by attempting
        //    undo, erase someone else's list (caught by a test). Blocking once more here ensures that
        //    even if more such state appears in the future, there is no gap to slip through.
        // Important: only on partitioning servers. Doing it everywhere was tried (red-team M3, 2026-10-16) and changed
        //    answers clients rely on (501 "collection off" became 404, route-specific 404 texts changed). The path risk of
        //    a hostile id is closed where ids become paths instead — FolderStore refuses anything but a plain name.
        if (workspace && packageId !== undefined && !(await store.getPackage(packageId))) {
          return errorResponse(404, 'NotFound', fill(tr('패키지 {0}을(를) 찾을 수 없습니다.'), { 0: packageId }));
        }
        const snapshot =
          packageId !== undefined &&
          MUTATING.has(request.method) &&
          !UNDO_PATTERNS.has(found.route.pattern) &&
          !UNDO_BARRIER_PATTERNS.has(found.route.pattern)
            ? await undo.capture(packageId, describeChange(request.method, request.path), actor?.name, SIDECAR_PATTERNS.has(found.route.pattern))
            : undefined;
        const response = await found.route.handle({ request: inbound, params: found.params });
        // Important: the demo account **cannot take files out.** It looks at the outgoing response — even as download paths
        //    grow, nothing is missed (demo.ts) — and at the route's declared intent, for files that go out inline (router.ts)
        if (options.demo && isDemoAccount(options.demo, principal) && (found.route.fileDownload || isFileDownload(response))) {
          return errorResponse(
            403,
            'Forbidden',
            tr('데모 계정으로는 파일을 내려받을 수 없습니다. 「회원가입」으로 계정을 만들면 받을 수 있습니다.'),
          );
        }
        if (packageId !== undefined && response.status < 300 && MUTATING.has(request.method) && UNDO_BARRIER_PATTERNS.has(found.route.pattern)) {
          undo.forget(packageId);
        }
        if (snapshot && packageId !== undefined && response.status < 300) {
          if (request.method === 'DELETE' && found.route.pattern === '/packages/:packageId') undo.forget(packageId);
          else await undo.commit(packageId, snapshot);
        }
        return response;
      } catch (error) {
        return toErrorResponse(error);
      }
    })));
  }
}

/**
 * This request's workspace.
 *
 * | Who | Key | Sees everything |
 * |---|---|---|
 * | Demo account | `visitor:<name differing per login>` | No — even on the same account they can't see each other |
 * | Signed-up user | `user:<account id>` | No — same slot even after logging in again |
 * | Admin | `user:<account id>` | **Yes** — operating requires seeing others' items |
 * | API key | `apikey` | **Yes** — machine integrations (registry, collection) handle everything |
 * | Otherwise | `anonymous` | No — only shared (ownerless) items are visible |
 *
 * Important: partitioning the demo account by account id puts **everyone in one slot** — it is one account shared by many.
 */
function workspaceOf(
  principal: Principal | undefined,
  allowed: AuthResult,
  demo: DemoConfig | undefined,
): Workspace {
  if (principal) {
    if (demo && principal.login.toLowerCase() === demo.login.toLowerCase()) {
      return { key: `${VISITOR_PREFIX}${principal.visitor}`, seesAll: false };
    }
    return { key: `user:${principal.userId}`, seesAll: principal.role === 'admin' };
  }
  if (allowed.via === 'apikey') return { key: 'apikey', seesAll: true };
  return { key: 'anonymous', seesAll: false };
}

/** Whether this is the shared demo account — the criterion distinguishing it from one's own signed-up account */
function isDemoAccount(demo: DemoConfig, principal: Principal | undefined): boolean {
  // Important: not being logged in (a server with auth off) also counts as demo — on a public server,
  //    opening downloads to people who came in without logging in would defeat the purpose of blocking
  if (!principal) return true;
  return principal.login.toLowerCase() === demo.login.toLowerCase();
}

/**
 * This request's actor.
 *
 * Important: **non-humans are recorded too.** If changes made via API key are left as "no record", then later
 *    when reviewing the audit record, "old records" and "things a machine did" cannot be told apart. Machines are recorded as machines,
 *    but **which key is not recorded** — key values are secret, and logs travel around in plain text.
 * Important: servers not using authentication (installed edition, development) give undefined. On a single-user PC "who" means nothing,
 *    and writing an arbitrary name would invent a fact that never existed.
 */
function actorOf(principal: Principal | undefined, allowed: AuthResult): Actor | undefined {
  if (principal) return { id: principal.userId, name: principal.displayName };
  // i18n-ignore — the actor name stored in the change history (DB actor_name). Converting it to the request language would mix records
  if (allowed.via === 'apikey') return { id: 'apikey', name: 'API 키' };
  return undefined;
}

/** Undo and redo — non-spec operations (registered in EXTENSIONS) */
function undoRoutes(undo: UndoStack): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/packages/:packageId/undo',
      success: [200],
      handle: async ({ params }) => json(200, undo.status(params['packageId']!)),
    },
    {
      method: 'POST',
      pattern: '/packages/:packageId/undo',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const undone = await undo.undo(packageId);
        if (undone === undefined) throw new ApiError(409, 'Conflict', tr('되돌릴 변경이 없습니다.'));
        return json(200, { undone, ...undo.status(packageId) });
      },
    },
    {
      method: 'POST',
      pattern: '/packages/:packageId/redo',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const redone = await undo.redo(packageId);
        if (redone === undefined) throw new ApiError(409, 'Conflict', tr('다시 할 변경이 없습니다.'));
        return json(200, { redone, ...undo.status(packageId) });
      },
    },
  ];
}

export function toErrorResponse(error: unknown): ApiResponse {
  if (error instanceof ServiceBusyError) {
    const busy = errorResponse(error.status, error.code, error.message);
    return { ...busy, headers: { ...busy.headers, 'retry-after': String(error.retryAfterSeconds) } };
  }
  if (error instanceof ApiError) return errorResponse(error.status, error.code, error.message);
  if (error instanceof NotFoundError) return errorResponse(404, 'NotFound', error.message);
  if (error instanceof ForbiddenError) return errorResponse(403, 'Forbidden', error.message);
  if (error instanceof ConflictError) return errorResponse(409, 'Conflict', error.message);
  if (error instanceof ExternalRefConflictError) {
    const base = errorResponse(409, 'ExternalRefConflict', error.message);
    return { ...base, body: { ...(base.body as Record<string, unknown>), claims: error.claims } };
  }
  if (error instanceof InvalidContentError) return errorResponse(400, 'BadRequest', error.message);
  if (error instanceof ValueNotSupportedError) return errorResponse(400, 'BadRequest', error.message);
  // Exceeding a limit is not a format error but means "too large" — 413 is correct (spec VIII Zip Bomb)
  if (error instanceof AasxLimitError) return errorResponse(413, 'PayloadTooLarge', error.message);
  if (error instanceof AasxReadError) return errorResponse(400, 'BadRequest', error.message);
  if (error instanceof Error && error.message.startsWith('base64url')) {
    return errorResponse(400, 'BadRequest', error.message);
  }
  // Reaching here means something we didn't anticipate. Do not hide the original message — diagnosis comes first in air-gapped operation
  return errorResponse(500, 'InternalServerError', error instanceof Error ? error.message : String(error));
}
