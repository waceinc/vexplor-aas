/**
 * API options — the bundle of settings createApi takes.
 * Split out of api.ts (2026-10-14, 300-line rule) — content and comments were moved verbatim. Use it via api.ts from outside.
 */
import type { AasxLimits } from '@aas/aasx';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import type { LinterPolicy } from '@aas/linter';
import type { AuthConfig } from './auth.js';
import type { ApiRequest } from './http.js';
import type { DemoConfig } from './demo.js';
import type { IntegrationStore } from '@aas/store';
import type { IntegrationRouteBuilders } from './integration/compose.js';
import type { IntegrationRuntimeDeps, IntegrationServices } from './integration/deps.js';
import type { Route } from './router.js';
import type { PackageRouteOptions } from './routes/packages.js';
import type { LoginThrottle, SessionStore, SignupThrottle } from './session.js';
import type { UndoStack } from './undo.js';
import type { EdgeLimits } from './edge/routes-edge.js';
import type { EdgeRegistry } from './edge/state.js';

export interface ApiOptions {
  /** Extra routes — extension point for tests */
  routes?: Route[];
  /** Decompression cap for uploaded AASX (plan Ⅷ). If unset, the @aas/aasx default */
  aasxLimits?: Partial<AasxLimits>;
  /** Collection adapter (M8). Without it, collection routes respond 501 */
  openReader?: (descriptor: AidInterface) => Promise<ProtocolReader>;
  /**
   * Equipment browse — connects and fetches the tag list. 501 if absent.
   * Important: only @aas/opcua knows the protocol, so this is injected too (same principle as openReader).
   */
  browseDevice?: (endpoint: string) => Promise<unknown>;
  /** Built-in virtual PLC (simulation). Without it, "connect to virtual PLC" is 501 */
  simulate?: PackageRouteOptions['simulate'];
  /** Server default linter policy (rule-conflict choice). A query parameter takes precedence */
  policy?: Partial<LinterPolicy>;
  /**
   * Allowed cross origins (CORS_ORIGIN). Used for the origin check on **writes** arriving via a cookie session —
   * changes from sites not listed here are rejected (security.ts). If empty, only the same origin is allowed.
   */
  corsOrigins?: readonly string[];
  /**
   * Install code to ask for when creating the first admin. Only given on servers open to the outside —
   * servers open only on this machine (protected mode) do not ask (security.ts).
   */
  setupCode?: string;
  /**
   * Trial settings (`DEMO_MODE=on`). If given, **the demo account cannot download files** —
   * signing up and logging in with one's own account allows it. If not given, there are no restrictions (demo.ts).
   */
  demo?: DemoConfig;
  /**
   * Self sign-up (`AAS_SIGNUP=on`). If not given, the sign-up route returns 403.
   * Without `privacyUrl`, **contact details are not collected** (a privacy policy is required first).
   */
  signup?: { role: 'admin' | 'editor' | 'viewer'; privacyUrl?: string };
  /**
   * Whether to separate workspaces per person (`AAS_WORKSPACE=private`, automatic in trial mode).
   *
   * The default is **not to separate** — a team viewing the same files together is this tool's basic use.
   * When separated, each person sees only what they uploaded; others' files look as if they do not exist (@aas/store scoped.ts).
   */
  privateWorkspaces?: boolean;
  /**
   * Number of files one person may own on a separating server (default 50). 0 means unlimited.
   * Important: prevents filling the disk on a public server — trial visitors have the 60-minute cleanup, registered users do not
   */
  maxPackagesPerOwner?: number;
  /** Sign-up rate limit. Important: injected from outside so tests can control the clock */
  signupThrottle?: SignupThrottle;
  /** Access control (machine API keys). Open if not given (development/demo use) */
  auth?: AuthConfig;
  /**
   * Login sessions — if not given, this API creates its own.
   * Important: injected from outside so tests can control the clock.
   */
  sessions?: SessionStore;
  /** Behind HTTPS — whether to set the Secure cookie flag. Enabling it over plain HTTP makes login impossible */
  secureCookie?: (request: ApiRequest) => boolean;
  /**
   * Address used to reach this server from outside (the address the registry advertises).
   * Important: always set it behind a reverse proxy — advertise a wrong address and nobody can find their way here.
   * Can also be given via the `AAS_PUBLIC_URL` environment variable.
   */
  publicBaseUrl?: string;
  /** Undo stack. createApi creates and passes it — not needed when checking the route table */
  undo?: UndoStack;
  /** Integration workers (integration/boot.ts). Absent when INTEGRATIONS is off — routes that send answer 503 */
  integration?: IntegrationRuntimeDeps;
  /** Integration server facts (instance id, egress policy, master key). Absent in tests — routes use defaults */
  integrationServices?: IntegrationServices;
  /** Collection interval (ms) — the detection resolution the integration routes report */
  collectIntervalMs?: number;
  /** Login attempt limit — server.ts shares it with the OPC UA account check. createApi creates one if absent */
  loginThrottle?: LoginThrottle;
  /** The unscoped store audit events are written to — createApi sets it (integration/deps.ts `auditStore`) */
  integrationAuditStore?: Pick<IntegrationStore, 'appendEvents'>;
  /** Which WP2 / WP4 integration route builders to mount (default: all). Tests that mount their own pass `{}` */
  integrationRouteBuilders?: IntegrationRouteBuilders;
  /**
   * Remote collectors (docs/edge-contract.md). Absent = off: `/edge/v1/*` is not answered and the management routes are
   * not mounted. Never on in demo mode. server.ts turns it on with `EDGE=on`.
   */
  edge?: EdgeConfig;
  /** The device registry — createApi creates it from `edge` and passes it to the route table */
  edgeRegistry?: EdgeRegistry;
}

export interface EdgeConfig {
  /** Read interval the read list gives every interface (ms). Default 5000 */
  intervalMs?: number;
  pollSeconds?: number;
  limits?: Partial<EdgeLimits>;
}
