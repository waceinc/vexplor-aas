# VEXPLOR AAS Studio — MES / ERP / CMMS integration, release design (v1)

Synthesised on 2026-10-14 from five independent expert opinions — MES, ERP, CMMS, integration platform and AAS
standards — kept next to this file in `integration-experts/`.


Scope rule: this is a **complete first release**. Everything below "SHIP" is built, tested and documented in this release.
"LATER" is listed in §14 with the reason. Nothing is "maybe". `[unverified]` marks facts not confirmed against code or a
normative text in hand; each such item says how the implementer confirms it.

Facts verified in the code while writing this (they shape decisions):

| Fact | Where | Consequence |
|---|---|---|
| `AasStore` has three implementations; `FolderStore extends InMemoryStore`; `ScopedStore` implements the port by hand | `packages/store/src/*` | Integration methods go into the port and all four classes; conformance suite covers them |
| Schema is at version 8; `runStatements` splits SQL on `;` | `schema.ts`, `postgres.ts:226` | v9 SQL must contain no `;` inside comments or strings |
| Actor is carried by AsyncLocalStorage, set once in `createApi` | `actor.ts`, `api.ts` | Same mechanism carries `cause` / `changeSetId` |
| `scripts/part2-coverage.mjs` exits 1 for any route in `buildRoutes` that is not in the spec **or** in `EXTENSIONS` | `part2-coverage.mjs:206,261` | Every new path must be added to `EXTENSIONS` by the package that owns the routes aggregator |
| `/description` claims can only be verified when the profile's YAML is vendored; only SSP-001 YAMLs exist in `docs/spec/part2/` | `part2-coverage.mjs:183` | Read profiles (SSP-002) are **not** advertised in this release (§1, D10) |
| `AAS_PUBLIC_URL` / `publicBaseUrl` already exists and is used for registry descriptor hrefs | `server.ts:175`, `registry.ts:35` | Reused for event links and `dataschema`; no new setting |
| Discovery bug: `want.name === 'globalAssetId'` matches any link value; missing `name` defaults to `globalAssetId` | `registry.ts:208,322` | Fixed in this release |
| Supervisor sweeps all packages each interval and sinks samples via `store.appendValues` | `supervisor.ts` | Detector hook = wrap the sink + per-package callback |
| MQTT wire supports QoS 0 publish only; test broker exact-topic, QoS 0, no PUBACK | `mqtt-wire.ts`, `mqtt-broker.ts` | QoS 1 publisher + broker QoS 1 / wildcards are feasible without deps |
| node-opcua 2.178.0 typings expose `securityPolicies`, `securityModes`, `allowAnonymous`, `userManager.isValidUserAsync(username, password, cb)`, `serverCertificateManager: OPCUACertificateManager({ rootFolder, automaticallyAcceptUnknownCertificate })`, `CertificateManager.trustCertificate()`, `.rejectedFolder`, `.trustedFolder`; `SecurityPolicy` and `MessageSecurityMode` are re-exported from `node-opcua` | `node_modules/node-opcua-server/dist/opcua_server.d.ts:61-71,191,254`, `user_manager.d.ts:6`, `node-opcua-pki/dist/index.d.ts:1279-1302` | OPC UA authentication is **in scope** (§7) |
| State rules live in `localStorage` key `aas.stateRules`; day start hard-coded `START_HOUR = 8` | `DailyStates.tsx` | Moved server-side (§6) |
| Fresh window = `max(5 min, 3 × interval)` | `apps/web/.../freshness.ts` | Same constant used by the server detector |
| Web depends on `@aas/core` and `@aas/linter` only; vitest aliases `@aas/*` to sources | `apps/web/package.json`, `vitest.config.ts` | Shared state logic goes into `@aas/core` (browser-safe, no `node:` imports) |
| Server i18n dictionary is split per area in `packages/aas-core/src/i18n/en/*.ts`; web dictionary is `apps/web/src/en.ts` | `i18n/index.ts`, `i18n.ts` | Each work package gets its own server dictionary file |
| Vite dev proxy lists top-level API paths by regex | `apps/web/vite.config.ts:20` | Add `integrations` |

---

## 1. Decisions where the experts disagree

| # | Question | Decision | One-line reason |
|---|---|---|---|
| D1 | Where do ERP/MES/CMMS ids live — in AASX `specificAssetIds` (AAS) or outside (ERP)? | **Sidecar store document per package is authoritative**; per-ref opt-in `publish: true` projects it into the shell's `specificAssetIds` through a normal `updateIdentifiable` (cause `external-refs`). `type: costCenter` and `sensitive: true` refs are never projected, never exported, never put in events. | AASX files leave the company (suppliers, KTL), so internal numbers stay outside by default, while opt-in projection keeps discovery and the AASX consistent (single source when published). |
| D2 | Should discovery also match sidecar refs? | **No.** `/lookup/shells` matches only what is in the AAS. | Lookup and AASX download must never disagree (AAS expert §1). Integrators who need lookup by ERP number publish that ref. |
| D3 | State judgement: browser (today) or server? | **Server.** Rules move to server config; the pure logic moves to `@aas/core` and is used by both server and web. | Two screens with two rule sets give two answers; events need one judge. |
| D4 | Event envelope: CloudEvents (MES, platform) vs `EventPayload` field names (AAS) | **CloudEvents 1.0 structured JSON envelope**; inside `data`, element references use the `EventPayload` names (`observableReference`, `observableSemanticId`) and raw ids; the remaining `EventPayload` fields map as `source`→`data.asset.aasId`/`submodelId`, `timeStamp`→`data.observedAt` (mapping table in the docs, no duplicate alias fields). | CloudEvents is what iPaaS/MES middleware parses; the AAS names inside `data` keep a later IDTA mapping a rename. |
| D5 | One events feed vs separate ERP change feed (`/erp/changes`) | **One log, one feed** (`GET /integrations/events`). ERP-shaped events (`equipment.master.changed` with `changedKeys`) are derived events in the same log. | One cursor, one retention, one delivery machinery; consumers filter by `types`. |
| D6 | Event id: ULID/UUID (platform) vs deterministic hash (MES) | **Model events: `randomUUID()`** (each commit is unique). **Runtime and projection events: deterministic** `evt_` + base32(sha256(type, key, occurredAt, value)) first 26 chars; store `id` is UNIQUE and duplicates are silently skipped. | A re-processed cycle after a crash produces the same id and is not re-emitted. |
| D7 | Ordering: per-asset head-of-line (MES, CMMS) vs no ordering guarantee (platform) | **No delivery ordering guarantee**; every event carries global `sequence`, `vxrevision` (model) and `time`; the pull feed is totally ordered. Per-asset FIFO is LATER. | One flaky receiver must not stall a plant; consumers needing order use the pull feed. |
| D8 | Retry schedule (MES 24 h hourly vs platform 12 attempts ~40 h) | **Platform schedule**: 0, 10 s, 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h, 8 h, 8 h (12 attempts), ±20 % jitter. | Covers a weekend MES shutdown, then dead-letter for manual replay. |
| D9 | Lint rules "Type with SerialNumber" and "BOM root ≠ shell asset" — linter catalog or not? | **Not in the linter catalog.** They become **integration readiness checks** (`INT-1…INT-5`, §8) reported by `GET /integrations/readiness` and enforced by the exports. | The lint catalog is the KOSMO submission contract and its rule list is CI-checked (`make-rule-list --check`); adding warnings there changes every submission report for an unrelated audience. |
| D10 | Advertise Part 2 read profiles (SSP-002) in `/description`? | **No change this release.** | The SSP-002 operation lists are not vendored, so `part2-coverage.mjs` cannot prove the claim; an unproven profile is worse than none (AAS §1.1). |
| D11 | Who may manage subscriptions | **Admin session only.** `full` API keys and editors get 403; open-mode servers (no accounts, no keys) get 403 "create an admin first". Reading the pull feed: any authenticated reader (viewer, read-only key), workspace-scoped. | An outbound webhook on an open server is an SSRF and exfiltration relay. |
| D12 | Thin vs fat events | **Thin**: identifiers, revisions, operation, actor, links. No submodel content. `includeContent` is LATER. | AAS bodies can be MB; receivers re-read via Part 2. |
| D13 | Counter rollover guessing (CMMS: near 16/32-bit max) vs only when declared (MES) | **Only when `max` is configured** for that counter; otherwise `reset: true, delta: null`. | No invented numbers. |
| D14 | Alarm from `state = alarm` vs from a dedicated alarm tag | **Alarm events only from configured alarm rules.** State transitions to `alarm` emit `equipment.state.changed` only. | Avoids double events and guessed alarm identity. |
| D15 | Default of `INTEGRATIONS` | **Model events are always recorded** by the store (outbox) and the pull feed always works. `INTEGRATIONS=on` starts detector, projector and delivery workers. Forced off in `DEMO_MODE`. | Recording is cheap and keeps the log gap-free; outbound connections need an explicit decision (same philosophy as `COLLECT`, `OPCUA_SERVER`). |
| D16 | OPC UA default security | **Secure by default** when `OPCUA_SERVER=on`: no `None`, no anonymous, username = existing accounts. `OPCUA_ALLOW_INSECURE=on` restores the old behaviour with a startup warning. If no account exists and insecure is not allowed, the OPC UA server does not start and says why. | "Never point an MES at an unauthenticated port" (all three domain experts). Breaking change is documented in the release notes. |
| D17 | Webhook `http://` | Allowed only when the target host/IP is matched by `AAS_INTEGRATION_ALLOW`; `https://` anywhere public or allowlisted. | Internal plant MES often has no TLS; the allowlist is the explicit admin decision. |
| D18 | Subscriptions per workspace | **Server-wide only** this release (admin creates them; admin sees all). | Workspace-owned subscriptions add a second visibility rule for little demand. |
| D19 | ISA-95 level storage (MES wants explicit per node) | Default mapping by node kind (entry = Enterprise, `line: true` = Area, other group = WorkCenter, node with `globalAssetId` = WorkUnit) + **per-node override** and optional `site` in the process file's package integration config, keyed by node path. Overrides whose path no longer exists are reported as warnings. | Explicit where it matters, zero editing for the common single-site case, no model change. |
| D20 | Meter readings: push or pull | **Pull** `GET /integrations/meters` (computed from stored values, deterministic `readingId`) **plus** push of `equipment.counter.advanced` per cycle. | CMMS polls meters daily; the push event covers MES. |

---

## 2. Event model

### 2.1 Envelope (CloudEvents 1.0, structured JSON)

Rendered by `apps/api/src/integration/cloudevents.ts` → `toCloudEvent(row: StoredEvent, ctx: { instanceId: string; publicBaseUrl?: string }): CloudEvent`.
Rendering depends **only** on the stored row and `ctx`, so a replay is byte-identical (signature header aside).

```json
{
  "specversion": "1.0",
  "id": "evt_3K7Q9ZB2M4XH8V0TQW5N6R1JPC",
  "source": "urn:vexplor-aas:9f2c4e1a7b3d",
  "type": "kr.vexplor.aas.equipment.state.changed.v1",
  "time": "2026-10-14T01:41:07.300Z",
  "subject": "https://example.com/ids/asset/press-03",
  "datacontenttype": "application/json",
  "dataschema": "https://aas.plant.local/integrations/schemas/kr.vexplor.aas.equipment.state.changed.v1",
  "sequence": "00000000000000184223",
  "vxpackageid": "pkg_12",
  "vxrevision": 37,
  "vxcause": "edit",
  "vxchangeset": "chg_5f1d0c2e",
  "data": { }
}
```

Rules:
- `source` = `urn:vexplor-aas:<instanceId>`; `instanceId` is 12 hex chars generated once and stored in the server integration config (`instanceId`), so it survives restarts.
- `subject`: runtime and projection events → raw `globalAssetId`; model events → `packages/<packageId>/<shells|submodels|concept-descriptions>/<base64url id>`; package events → `packages/<packageId>`.
- `dataschema` only when `AAS_PUBLIC_URL` is set (absolute URI required); otherwise omitted.
- `sequence` = store `seq`, zero-padded to 20 digits (CloudEvents sequence extension is a string).
- Extensions only when present on the row: `vxpackageid`, `vxrevision` (package revision after the change), `vxcause` (`edit|fix|import|undo|redo|derivation|external-refs|seed|system`), `vxchangeset`.
- Content type of a delivered body: `application/cloudevents+json; charset=utf-8`.
- Ids inside `data` are raw strings; only URLs carry base64url (unpadded) — same as Part 2.

### 2.2 Shared blocks inside `data`

**`asset` join block** (runtime + projection events; resolved by `AssetJoinResolver`, §4.6):
```json
"asset": {
  "globalAssetId": "https://example.com/ids/asset/press-03",
  "aasId": "https://example.com/ids/aas/press-03",
  "packageId": "pkg_12",
  "assetKind": "Instance",
  "serialNumber": "SN-2024-00317",
  "specificAssetIds": [ { "name": "mesResourceId", "value": "PRS-03" } ],
  "externalRefs": [ { "system": "mes:changwon", "type": "equipmentCode", "id": "PRS-03" } ],
  "path": ["WACE", "Changwon", "Line-A", "Pressing", "Press-03"],
  "isa95": { "enterprise": "WACE", "site": "Changwon", "area": "Line-A", "workCenter": "Pressing", "workUnit": "Press-03" }
}
```
- `serialNumber`: DigitalNameplate `SerialNumber` (by semanticId `0112/2///61987#ABA951#009`, then idShort) or `null`. Never invented.
- `externalRefs`: only refs with `sensitive !== true` and `type !== 'costCenter'`.
- `path` / `isa95`: from the first process file whose hierarchy references this `globalAssetId`; `[]` / `null` if none. If several process files reference it, the one with the lowest package id wins and `data.asset.pathAmbiguous: true` is added.
- `packageId` is documented as "internal, not stable across re-imports".

**`source` element block** (runtime events):
```json
"source": {
  "interfaceName": "PLC1",
  "propertyName": "MachineState",
  "address": "ns=1;s=Machine.State",
  "submodelId": "https://example.com/ids/sm/OperationalData",
  "idShortPath": "MachineState",
  "semanticId": "https://example.com/ids/cd/MachineState",
  "observableReference": { "type": "ModelReference", "keys": [
    { "type": "Submodel", "value": "https://example.com/ids/sm/OperationalData" },
    { "type": "Property", "value": "MachineState" } ] },
  "simulated": false
}
```
- `address` has credentials masked (`mqtt://user:***@host`); masking is `maskCredentials(url)` in `apps/api/src/integration/ids.ts`.
- `submodelId`, `idShortPath`, `semanticId`, `observableReference` are `null` when the AID property cannot be resolved to a model element (resolution = same name rule as the `?live=true` overlay in `packages/collector/src/overlay.ts`; the implementer reuses its lookup — [verify the exported helper name in overlay.ts; export one if needed, owned by WP2]).
- `simulated: true` when the AID interface endpoint is the built-in virtual PLC (loopback host and path ending `/UA/Simulator`, i.e. `SIMULATOR_RESOURCE_PATH`).

### 2.3 Catalogue (all types are `kr.vexplor.aas.<name>.v1`)

| Type (`<name>`) | Class | Emitted by (file → function) | Deliverable |
|---|---|---|---|
| `model.package.created` | model | store `importPackage` (memory, folder, postgres) | yes |
| `model.package.deleted` | model | store `deletePackage` | yes |
| `model.package.file.changed` | model | store `putPackageFile`, `deletePackageFile` | yes |
| `model.shell.created` / `.updated` / `.deleted` | model | store `createIdentifiable` / `updateIdentifiable` / `deleteIdentifiable` (modelType AAS) | yes |
| `model.submodel.created` / `.updated` / `.deleted` | model | same, modelType Submodel | yes |
| `model.conceptdescription.created` / `.updated` / `.deleted` | model | same, modelType ConceptDescription | yes |
| `equipment.master.changed` | projection | `integration/exports/projector.ts` → `IntegrationProjector.flush()` | yes |
| `equipment.bom.changed` | projection | same | yes |
| `equipment.maintenance.changed` | projection | same | yes |
| `equipment.documents.changed` | projection | same | yes |
| `equipment.state.changed` | runtime | `integration/runtime/detector.ts` → `EquipmentDetector.onPackageCycle()` | yes |
| `equipment.alarm.raised` / `.cleared` | runtime | same (`alarms.ts`) | yes |
| `equipment.counter.advanced` | runtime | same (`counters.ts`) | yes |
| `equipment.threshold.crossed` / `.returned` | runtime | same (`thresholds.ts`) | yes |
| `collection.connection.lost` / `.restored` | runtime | same (`connection.ts`) | yes |
| `integration.audit` | audit | integration routes (subscription CRUD, rotate, redeliver, replay, refs import, config change) | **no**; visible in feed only to admins |
| `integration.ping` | test | `POST /integrations/subscriptions/:id/test` | sent directly, never stored |

Model `data` payloads (built inside the store; content-free):

```json
// model.package.created.v1
{ "packageId": "pkg_12", "name": "Press-03.aasx", "owner": null, "globalAssetId": "https://…/asset/press-03", "aasId": "https://…/aas/press-03",
  "counts": { "AssetAdministrationShell": 1, "Submodel": 9, "ConceptDescription": 120 } }
// model.package.deleted.v1
{ "packageId": "pkg_12", "name": "Press-03.aasx", "globalAssetId": "https://…/asset/press-03", "aasId": "https://…/aas/press-03" }
// model.package.file.changed.v1
{ "packageId": "pkg_12", "part": "/aasx/files/manual.pdf", "role": "supplementary", "operation": "put" }
// model.shell|submodel|conceptdescription.created|updated|deleted.v1
{ "packageId": "pkg_12", "modelType": "Submodel", "id": "https://…/sm/TechnicalData", "idShort": "TechnicalData",
  "semanticId": "https://admin-shell.io/ZVEI/TechnicalData/Submodel/1/2", "operation": "update",
  "identifiableRevision": 5, "packageRevision": 37,
  "globalAssetId": "https://…/asset/press-03", "aasId": "https://…/aas/press-03",
  "actor": { "id": "user_3", "name": "Kim" } }
```
`globalAssetId` / `aasId` = the package's first AAS (by ordinal) at commit time, `null` if none. `actor` omitted when no actor.
The renderer adds `data.links.self` = `<base>/packages/<pkg>/api/v3.0/<shells|submodels|concept-descriptions>/<b64url id>` (absolute when `AAS_PUBLIC_URL`, else path-only) — derived from the row only.

Projection payloads:
```json
// equipment.master.changed.v1
{ "asset": { "…": "join block" }, "operation": "created|updated|removed",
  "changedKeys": ["nameplate.serialNumber"], "revision": 37, "projectionHash": "sha256:…",
  "href": "/integrations/exports/equipment?format=json&packageId=pkg_12" }
// equipment.bom.changed.v1 / equipment.maintenance.changed.v1 / equipment.documents.changed.v1
{ "asset": { "…": "…" }, "operation": "created|updated|removed", "revision": 37, "projectionHash": "sha256:…",
  "href": "/integrations/exports/bom?format=json&packageId=pkg_12" }
```
`changedKeys` = sorted list of column keys (§4.4 `EQUIPMENT_V1_COLUMNS`) whose value differs between the previous and current projection. Events are **state notifications**: consumers re-read `href`.

Runtime payloads:
```json
// equipment.state.changed.v1
{ "asset": {}, "source": {}, "state": "alarm", "previousState": "run",
  "previousStateSince": "2026-10-14T01:12:40.002Z", "previousDurationMs": 1707310,
  "rawValue": "3", "ruleSetHash": "sha256:9a1c…",
  "observedAt": "2026-10-14T01:41:06.900Z", "receivedAt": "2026-10-14T01:41:07.300Z",
  "quality": "Good", "detectionResolutionMs": 30000, "suppressed": false }
// equipment.alarm.raised.v1 / equipment.alarm.cleared.v1
{ "asset": {}, "source": {}, "alarmRuleId": "alarm-main",
  "alarmInstanceId": "alm_<26 base32 of sha256(globalAssetId|ruleId|raisedAt)>",
  "code": "E-217", "text": "Hydraulic pressure low", "severity": null,
  "raisedAt": "…", "detectedAt": "…", "clearedAt": null, "durationMs": null,
  "occurrences": 1, "maintenanceIds": [], "detectionResolutionMs": 30000, "suppressed": false }
// equipment.counter.advanced.v1
{ "asset": {}, "source": {}, "counterId": "produced", "counterKind": "total", "unit": null,
  "from": 15230, "to": 15241, "delta": 11,
  "intervalStart": "…", "intervalEnd": "…",
  "flags": { "reset": false, "rollover": false, "implausible": false, "gap": false }, "excludedBadSamples": 0 }
// equipment.threshold.crossed.v1 / equipment.threshold.returned.v1
{ "asset": {}, "source": {}, "thresholdId": "motor-temp-high", "direction": "above", "limit": 85, "hysteresis": 2,
  "value": 86.4, "unit": "degC", "severity": null, "observedAt": "…", "detectedAt": "…", "suppressed": false }
// collection.connection.lost.v1 / collection.connection.restored.v1
{ "asset": {}, "interfaceName": "OPCUA_Main", "protocol": "OPCUA", "endpoint": "opc.tcp://192.168.0.50:4840",
  "error": "connect ECONNREFUSED", "since": "…", "consecutiveFailures": 2, "simulated": false }
```
`severity` is `null` unless a person set it on the rule. `code` / `text` are `null` unless the rule names a code/text property.
`suppressed: true` when the package config's `suppressProperty` currently reads true/1 (events are still emitted, never dropped).

Audit and ping:
```json
// integration.audit.v1
{ "action": "subscription.created|subscription.updated|subscription.deleted|subscription.secret-rotated|subscription.replayed|delivery.redelivered|external-refs.imported|config.updated",
  "target": "sub_7c1e…", "actor": { "id": "user_1", "name": "Admin" }, "details": { } }
// integration.ping.v1
{ "subscriptionId": "sub_7c1e…", "serverTime": "…", "message": "VEXPLOR AAS Studio test delivery" }
```
`details` never contains secrets or full URLs with credentials.

### 2.4 Ordering, idempotency, guarantees (documented contract)

- **At-least-once** delivery. Receivers dedupe on CloudEvents `id` (= `webhook-id`) for ≥ 48 h.
- `sequence` is monotonic, **not gap-free** on PostgreSQL and the folder store. For model events of one package, `vxrevision` is strictly increasing; receivers ignore an event whose `vxrevision` ≤ the one already applied for that package.
- **Sequence visibility (outbox pitfall)** is handled by the shared helper `settledPrefix(rows, now, settleMs = 30_000)` in `apps/api/src/integration/ids.ts`: from a batch ordered by `seq`, return the longest prefix that is contiguous from the requested `after`, plus any rows after a gap whose `recordedAt` is older than `settleMs` (the gap is then a rollback). Used by the dispatcher fan-out and, on PostgreSQL, by the pull feed. The memory store has no gaps; the folder store can leave a permanent gap where an event was voided after a crash (its seq is never reused), so the feed does not wait on it.
- Feed `after` older than the oldest retained event (pruned) → **410** `{ code: "Gone", oldestSeq }`; consumers then do a full export.

### 2.5 JSON Schemas

`apps/api/src/integration/schemas.ts` exports one JSON Schema (draft 2020-12 subset: `type`, `properties`, `required`, `enum`, `items`, `nullable via type array`, `additionalProperties`) per type plus the envelope. `schema-check.ts` is a ~120-line in-repo validator for that subset (no dependency). Served at `GET /integrations/schemas` (list) and `GET /integrations/schemas/:type`. CI test validates every event produced by the test scenarios.

---

## 3. Store port additions

### 3.1 New contract file `packages/store/src/integration-types.ts` (WP0)

```ts
export interface StoredEvent {
  seq: number;                 // assigned by the store, monotonic
  id: string;                  // UNIQUE; duplicates are skipped on append
  type: string;
  time: string;                // occurredAt (ISO)
  recordedAt: string;          // append time (ISO) — retention and settle horizon
  packageId?: string;
  subject?: string;
  packageRevision?: number;
  owner?: string;              // copied from the package at append time (workspace filtering)
  actorId?: string;
  actorName?: string;
  cause?: string;
  changeSetId?: string;
  data: Record<string, unknown>;
}
export interface NewEvent {
  id: string; type: string; time: string;
  packageId?: string; subject?: string; packageRevision?: number;
  actorId?: string; actorName?: string; cause?: string; changeSetId?: string;
  data: Record<string, unknown>;
}
export interface EventQuery {
  after: number;               // exclusive
  limit: number;               // 1..1000
  types?: readonly string[];   // exact, or prefix ending in '*'
  packageId?: string;
  includeAudit?: boolean;      // default false
}
export interface EventPage { items: StoredEvent[]; oldestSeq: number | null; lastSeq: number }

export type SubscriptionKind = 'webhook' | 'mqtt';
export interface SubscriptionOptions { topicPrefix?: string; retainState?: boolean }
export interface SubscriptionRecord {
  id: string; name: string; kind: SubscriptionKind;
  url: string;                 // no userinfo ever (credentials are sealed separately)
  types: string[]; packageIds: string[];
  enabled: boolean; disabledReason?: string;
  options: SubscriptionOptions;
  secretHint: string;          // last 4 chars of the signing secret
  consecutiveDead: number; lastSuccessAt?: string;
  createdAt: string; updatedAt: string; createdBy?: string;
}
export interface SubscriptionSecrets {
  keyId: string;
  secretSealed: string;
  previousSealed?: string; previousUntil?: string;
  credentialsSealed?: string;  // mqtt "user:password"
}
export type NewSubscription = Omit<SubscriptionRecord, 'id' | 'createdAt' | 'updatedAt' | 'consecutiveDead' | 'lastSuccessAt'> & { secrets: SubscriptionSecrets };
export type SubscriptionPatch = Partial<Pick<SubscriptionRecord, 'name' | 'url' | 'types' | 'packageIds' | 'enabled' | 'disabledReason' | 'options' | 'secretHint' | 'consecutiveDead' | 'lastSuccessAt'>> & { secrets?: SubscriptionSecrets };

export type DeliveryStatus = 'pending' | 'in-flight' | 'succeeded' | 'dead';
export interface DeliveryRecord {
  id: string; subscriptionId: string; eventSeq: number; eventId: string;
  status: DeliveryStatus; attempts: number; nextAttemptAt: string; leaseUntil?: string;
  lastStatusCode?: number; lastError?: string; lastDurationMs?: number; lastAddress?: string;
  createdAt: string; updatedAt: string;
}
export interface DeliveryResult {
  outcome: 'succeeded' | 'retry' | 'dead'; at: string; nextAttemptAt?: string;
  statusCode?: number; error?: string; durationMs?: number; address?: string;
}
export interface DeliveryStats { subscriptionId: string; pending: number; inFlight: number; dead: number; succeeded: number; oldestPendingAt?: string }

export interface Versioned<T> { value: T; revision: number; updatedAt: string; actorId?: string; actorName?: string }

export interface ExternalRef {
  system: string;              // includes tenant/client, e.g. "sap-s4:PRD:100", "icube:WACE"
  type: string;                // equipment | plant | functionalLocation | workCenter | costCenter | material | equipmentCode | …
  id: string;
  publish?: boolean;           // project into specificAssetIds (never for costCenter / sensitive)
  sensitive?: boolean;         // never exported, never in events
  externalSubjectId?: string;  // IRI of the issuing system, used in projection
  syncedAt?: string; source?: string;
}
export interface ExternalRefSubject {
  subject: { kind: 'asset'; globalAssetId: string } | { kind: 'bomChild'; globalAssetId: string } | { kind: 'consumable' | 'tool'; globalAssetId: string; key: string };
  refs: ExternalRef[];
}
export interface ExternalRefsDoc { schema: 'vexplor.externalRefs/1'; subjects: ExternalRefSubject[]; managedSpecificAssetIds?: string[] }

/** (system, type, id) already claimed by another subject — mapped to 409 */
export class ExternalRefConflictError extends Error {
  constructor(readonly claims: { system: string; type: string; id: string; packageId: string; subject: string }[]) {
    super(/* tr('…') message listing the claims */); this.name = 'ExternalRefConflictError';
  }
}

export interface IntegrationStore {
  // events (model events are written internally by the mutating methods, never through appendEvents)
  appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]>;            // returns inserted rows only
  readEvents(query: EventQuery, scope?: PackageScope): Promise<EventPage>;
  pruneEvents(before: string): Promise<number>;                                  // by recordedAt

  // subscriptions
  listSubscriptions(): Promise<SubscriptionRecord[]>;
  getSubscription(id: string): Promise<(SubscriptionRecord & { secrets: SubscriptionSecrets }) | undefined>;
  createSubscription(input: NewSubscription): Promise<SubscriptionRecord>;
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | undefined>;
  deleteSubscription(id: string): Promise<boolean>;                             // cascades deliveries

  // deliveries
  enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[], now: string): Promise<number>; // idempotent on (subscriptionId, eventSeq)
  claimDeliveries(now: string, limit: number, leaseMs: number): Promise<DeliveryRecord[]>;   // due pending + expired in-flight; sets in-flight, leaseUntil, attempts+1
  completeDelivery(id: string, result: DeliveryResult): Promise<void>;
  getDelivery(id: string): Promise<DeliveryRecord | undefined>;
  listDeliveries(subscriptionId: string, query?: { status?: DeliveryStatus } & PageQuery): Promise<PageResult<DeliveryRecord>>; // newest first
  redeliver(id: string, now: string): Promise<boolean>;                         // -> pending, nextAttemptAt=now, attempts kept
  deliveryStats(): Promise<DeliveryStats[]>;
  pruneDeliveries(succeededBefore: string, deadBefore: string): Promise<number>;

  // configuration (opaque JSON; validated in the API layer)
  getServerIntegrationConfig(): Promise<Versioned<unknown> | undefined>;
  putServerIntegrationConfig(value: unknown, expectedRevision?: number): Promise<Versioned<unknown>>;
  getPackageIntegrationConfig(packageId: string): Promise<Versioned<unknown> | undefined>;
  putPackageIntegrationConfig(packageId: string, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>>;

  // external references (sidecar, not in the AASX)
  getExternalRefs(packageId: string): Promise<Versioned<ExternalRefsDoc> | undefined>;
  putExternalRefs(packageId: string, doc: ExternalRefsDoc, expectedRevision?: number): Promise<Versioned<ExternalRefsDoc>>; // ConflictError | ExternalRefConflictError
  findExternalRef(system: string, type: string, id: string): Promise<{ packageId: string; subject: string }[]>;
  listExternalRefs(): Promise<{ packageId: string; refs: Versioned<ExternalRefsDoc> }[]>;

  // internal runtime state (detector, projector, dispatcher cursors)
  getRuntimeState(key: string): Promise<unknown | undefined>;
  putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void>;
}
```
Revision rules: first put creates revision 1; each put +1; `expectedRevision` mismatch → `ConflictError`. Package deletion deletes that package's config, external refs and runtime state rows (and their uniqueness keys). The `subject` string used by uniqueness is `<kind>|<globalAssetId>[|<key>]`.

### 3.2 Change context `packages/store/src/change.ts` (WP0)

```ts
export interface ChangeContext { cause?: string; changeSetId?: string }
export function runWithChange<T>(context: ChangeContext | undefined, fn: () => T): T;
export function currentChange(): ChangeContext | undefined;
```
Separate AsyncLocalStorage (same pattern as `actor.ts`). Store implementations read it when building model events.

### 3.3 Memory reference implementation `packages/store/src/integration-memory.ts` (WP0)

`class MemoryIntegrationLog` holds events (cap 100 000; oldest dropped, `oldestSeq` advances), subscriptions, deliveries, configs, refs + key index, runtime state; implements every `IntegrationStore` method except it takes `owner` and package existence through a constructor callback `ownerOf(packageId) => string | undefined | null(missing)`. Also exposes `recordModelEvent(e: NewEvent & { owner?: string })`, `snapshot()` / `restore()` (JSON-transferable, used by FolderStore), and `forgetPackage(packageId)`. This lets WP2–WP4 test against a working log before WP1 merges, and WP1 composes it into `InMemoryStore` (no second implementation).

### 3.4 Schema migration v9 (`packages/store/src/schema.ts`, WP1)

Append to `SCHEMA_SQL`, add `MIGRATIONS` entry `{ version: 9, sql }` with the same statements, bump `SCHEMA_VERSION = 9`. No `;` inside comments.

```sql
CREATE TABLE IF NOT EXISTS integration_event (
  seq              bigserial PRIMARY KEY,
  id               text NOT NULL UNIQUE,
  type             text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  package_id       text,
  subject          text,
  package_revision integer,
  owner            text,
  actor_id         text,
  actor_name       text,
  cause            text,
  change_set_id    text,
  data             jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS integration_event_recorded_idx ON integration_event (recorded_at);
CREATE INDEX IF NOT EXISTS integration_event_pkg_idx ON integration_event (package_id, seq);
CREATE INDEX IF NOT EXISTS integration_event_type_idx ON integration_event (type, seq);

CREATE TABLE IF NOT EXISTS integration_subscription (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('webhook', 'mqtt')),
  url                text NOT NULL,
  types              jsonb NOT NULL DEFAULT '[]'::jsonb,
  package_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled            boolean NOT NULL DEFAULT true,
  disabled_reason    text,
  options            jsonb NOT NULL DEFAULT '{}'::jsonb,
  key_id             text NOT NULL,
  secret_sealed      text NOT NULL,
  previous_sealed    text,
  previous_until     timestamptz,
  credentials_sealed text,
  secret_hint        text NOT NULL,
  consecutive_dead   integer NOT NULL DEFAULT 0,
  last_success_at    timestamptz,
  created_by         text,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_delivery (
  id               bigserial PRIMARY KEY,
  subscription_id  text NOT NULL REFERENCES integration_subscription(id) ON DELETE CASCADE,
  event_seq        bigint NOT NULL,
  event_id         text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'in-flight', 'succeeded', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  lease_until      timestamptz,
  last_status_code integer,
  last_error       text,
  last_duration_ms integer,
  last_address     text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (subscription_id, event_seq)
);
CREATE INDEX IF NOT EXISTS integration_delivery_due_idx ON integration_delivery (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS integration_config (
  scope       text PRIMARY KEY,
  package_id  text REFERENCES aas_package(id) ON DELETE CASCADE,
  value       jsonb NOT NULL,
  revision    integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL,
  actor_id    text,
  actor_name  text
);

CREATE TABLE IF NOT EXISTS external_ref_doc (
  package_id  text PRIMARY KEY REFERENCES aas_package(id) ON DELETE CASCADE,
  doc         jsonb NOT NULL,
  revision    integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL,
  actor_id    text,
  actor_name  text
);

CREATE TABLE IF NOT EXISTS external_ref_key (
  system      text NOT NULL,
  type        text NOT NULL,
  ref_id      text NOT NULL,
  package_id  text NOT NULL REFERENCES aas_package(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  PRIMARY KEY (system, type, ref_id)
);

CREATE TABLE IF NOT EXISTS integration_state (
  key         text PRIMARY KEY,
  package_id  text REFERENCES aas_package(id) ON DELETE CASCADE,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL
);
```
`integration_config.scope` = `'server'` or `'package:<id>'`. No FK from `integration_event.package_id` (events outlive packages).

PostgreSQL specifics (WP1, `postgres-integration.ts` helper functions taking a `SqlClient`):
- Model events inserted with the same `tx` as `pushHistory` / `touch` (in `createIdentifiable`, `updateIdentifiable`, `deleteIdentifiable`, `importPackage`, `deletePackage`, `putPackageFile`, `deletePackageFile` — the last three get a `withTransaction` if they lack one). Package revision for the row = `SELECT revision FROM aas_package` after `touch`. A `ConflictError` rollback drops the event.
- `appendEvents`: `INSERT … ON CONFLICT (id) DO NOTHING RETURNING *`; owner via `(SELECT owner FROM aas_package WHERE id = $pkg)`.
- `bigserial` comes back as a string from `pg` → `Number()`.
- `claimDeliveries`: `UPDATE integration_delivery SET status='in-flight', lease_until=$now+lease, attempts=attempts+1, updated_at=$now WHERE id IN (SELECT id FROM integration_delivery WHERE (status='pending' AND next_attempt_at <= $now) OR (status='in-flight' AND lease_until < $now) ORDER BY next_attempt_at LIMIT $n FOR UPDATE SKIP LOCKED) RETURNING *`.
- `putExternalRefs`: in one transaction, delete this package's `external_ref_key` rows, insert the new keys (catch unique violation `23505` → query the conflicting claims → `ExternalRefConflictError`), upsert `external_ref_doc` with revision check.
- `readEvents(scope)`: `WHERE seq > $after AND (owner IS NULL OR owner = $owner)` when scope given.

### 3.5 Folder store behaviour (WP1, `folder-integration.ts`)

Files at the data-folder root (root files are never mistaken for packages — `init()` only scans directories):

| File | Content | Write mode |
|---|---|---|
| `events.jsonl` | one `StoredEvent` per line, or `{"void":"<id>"}` | append + `fsync` (open fd, `appendFile`, `fdatasync`) |
| `deliveries.jsonl` | full `DeliveryRecord` per line, last line per id wins | append; compacted at `init()` and on prune |
| `integration.json` | `{ subscriptions, secrets, configs, refs }` | temp + rename, serialized write queue (same pattern as `persistUsers`) |
| `integration-state.json` | runtime state map | temp + rename, serialized, written at most once per second (coalesced) |

Crash protocol for model events (platform §2.3): the overridden mutating methods call `super.*` (memory mutation + memory event), then **append the event line, then `persist()` the model**. At `init()`, after loading packages: an event whose `packageRevision` is greater than the loaded package revision, or a non-delete event for a missing package, or a `model.package.deleted` for a package that still exists, gets a `{"void": id}` line and is not loaded. `seq` resumes from the highest loaded seq. Document: integration guarantees assume a local disk (network filesystems have weaker rename/fsync) [unverified for Synology/SMB — documented as a limitation, not tested].

### 3.6 ScopedStore (WP1)

| Method group | Rule |
|---|---|
| `readEvents` | in a non-seesAll workspace, forces `scope = { owner: workspace.key }` (own + ownerless) and `includeAudit = false` |
| `appendEvents`, `pruneEvents`, subscriptions, deliveries, runtime state, `putServerIntegrationConfig` | `ForbiddenError` inside a non-seesAll workspace (server-only, like `pruneValues`) |
| `getServerIntegrationConfig` | pass through |
| `get/putPackageIntegrationConfig`, `get/putExternalRefs` | `readable` / `writable(packageId)` |
| `findExternalRef`, `listExternalRefs` | filter results to visible packages |

`ScopedStore implements AasStore` is hand-written, so the compiler forces each method to be decided.

### 3.7 Conformance tests to add (`packages/store/test/conformance-integration.ts`, called from `describeStore`)

1. Each of `importPackage`, `deletePackage`, `putPackageFile`, `deletePackageFile`, `create/update/deleteIdentifiable` produces exactly one event of the right type with the resulting `packageRevision`, `owner`, `actorId/actorName` (from `runAsActor`) and `cause/changeSetId` (from `runWithChange`).
2. `updateIdentifiable` with wrong `expectedRevision` → `ConflictError` and **no** event.
3. `readEvents` ordered by seq, `limit`, `types` exact and prefix `*`, `packageId`, `includeAudit`, and `scope` (own + ownerless only).
4. `appendEvents` with a duplicate id inserts once and returns only new rows.
5. `pruneEvents` removes only rows with `recordedAt < before`; `oldestSeq` advances.
6. Subscriptions CRUD; `secrets` round-trip byte-exact via `getSubscription`; `listSubscriptions` never includes `secrets`.
7. `enqueueDeliveries` idempotent; `claimDeliveries` never returns the same row twice within a lease; an expired lease is reclaimable; `attempts` increments on claim.
8. `completeDelivery` transitions (succeeded / retry with `nextAttemptAt` / dead), `redeliver` resets, `deliveryStats` counts, `pruneDeliveries` respects both cut-offs, `deleteSubscription` cascades.
9. Config and external refs: revision 1 → 2, stale `expectedRevision` → `ConflictError`; uniqueness → `ExternalRefConflictError` listing both claims; re-putting the same doc is idempotent; `findExternalRef`.
10. Runtime state round-trip; `deletePackage` removes the package's config, refs, keys and state.
11. Folder only (`folder.test.ts`): restart restores everything; torn write (inject failing `rename` after event append) → event voided and never returned; `deliveries.jsonl` compaction; `integration.json` written via temp+rename.
12. Postgres (`postgres.test.ts`, PGlite): v8 → v9 migration twice (idempotent); a v10 DB is refused (existing behaviour, add case); `postgres-real.test.ts` runs the same suite when `DATABASE_URL` is set.
13. `scoped.test.ts`: workspace user cannot read other workspaces' events, cannot touch subscriptions/state, can read/write own package config and refs, gets 404-equivalent for others'.

---

## 4. API

Common rules: JSON errors use the existing `errorResponse(status, code, message)`; messages via `tr()`. Auth levels: **read** = any authenticated principal with read access (viewer, read-only key, or open server); **edit** = full level (editor/admin session, full key); **admin** = admin **session** (D11). All new routes are in `buildRoutes` (via `integrationRoutes(store, deps)` in `apps/api/src/integration/routes.ts`) and every pattern is appended to `EXTENSIONS` in `scripts/part2-coverage.mjs`. When `deps.runtime` is absent (integrations off, tests, coverage script), routes that need workers answer **503** `IntegrationsOff` with the hint `INTEGRATIONS=on`.

### 4.1 Events and schemas

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/integrations/events` | read | `after` (default 0), `limit` (1–1000, default 200), `types` (comma list, prefix `*` allowed), `packageId` | `200 { "items": [CloudEvent], "nextAfter": "184223", "oldestSeq": "1000", "serverTime": "…" }`; `nextAfter` = last returned seq or the given `after` if empty. Audit events only for admin sessions. 400 bad params; **410** when `after < oldestSeq - 1` |
| GET | `/integrations/schemas` | read | — | `200 { "types": ["kr.vexplor.aas.…v1", …] }` |
| GET | `/integrations/schemas/:type` | read | — | `200` JSON Schema; 404 unknown |

### 4.2 Subscriptions, deliveries, test, status (admin)

| Method | Path | Request | Response / errors |
|---|---|---|---|
| POST | `/integrations/subscriptions` | `{ "name", "kind": "webhook"\|"mqtt", "url", "types": [..], "packageIds"?: [..], "enabled"?: true, "options"?: { "topicPrefix", "retainState" } }` — MQTT credentials may be given in the URL userinfo and are stripped + sealed | `201 { "subscription": SubscriptionRecord, "secret": "whsec_…" }` (secret shown once). 400 invalid url/type/filters; 403 not admin / open mode; **422** `TargetNotAllowed` (egress policy, with reason); 503 no master key (`AAS_SECRET_KEY` missing on Postgres) |
| GET | `/integrations/subscriptions` | — | `200 { "items": [SubscriptionRecord + "stats": DeliveryStats] }` |
| GET | `/integrations/subscriptions/:id` | — | `200 SubscriptionRecord`; 404 |
| PATCH | `/integrations/subscriptions/:id` | any of `name, url, types, packageIds, enabled, options`; enabling clears `disabledReason` and `consecutiveDead` | `200 SubscriptionRecord`; url change re-runs the egress check (422) |
| DELETE | `/integrations/subscriptions/:id` | — | `204`; deliveries cascade |
| POST | `/integrations/subscriptions/:id/rotate-secret` | — | `200 { "secret": "whsec_…", "previousValidUntil": "…" }` — old secret valid 24 h, both signatures sent meanwhile |
| POST | `/integrations/subscriptions/:id/test` | — | `200 { "ok": true, "statusCode": 200, "durationMs": 41, "address": "10.20.1.5", "responseSnippet": "…(≤1 KB)", "serverTime": "…" }` or `{ "ok": false, "error": "…" }` — sends `integration.ping.v1` signed exactly like real events; records nothing in the outbox; writes an audit event |
| POST | `/integrations/subscriptions/:id/replay` | `{ "fromSeq": "1000" }` or `{ "from": "ISO time" }` | `200 { "enqueued": 312 }` (matching filters; idempotent with existing rows → re-set to pending) |
| GET | `/integrations/subscriptions/:id/deliveries` | `status`, `limit` (≤200), `cursor` | `200 { "items": [DeliveryRecord + "type"], "cursor"? }` |
| POST | `/integrations/deliveries/:id/redeliver` | — | `200 DeliveryRecord`; 404 |
| GET | `/integrations/status` | — (admin) | `200 { "enabled": true, "demo": false, "instanceId", "serverTime", "workers": { "dispatcher": { "running", "lastFanoutAt", "cursor" }, "projector": {…}, "detector": { "enabled", "lastCycleAt" } }, "backlog": { "pending", "oldestPendingAt", "dead" }, "egress": { "allow": ["10.20.0.0/16"], "blockedPorts": [...] }, "masterKey": "env\|file\|ephemeral\|missing", "opcua": { "security": "secure\|insecure\|off", "pki": "…" } }` |

### 4.3 Configuration (state rules, shift calendar, per-package rules)

Server config `vexplor.serverIntegrationConfig/1` (validated by `parseServerIntegrationConfig` in `@aas/core`):
```json
{ "schema": "vexplor.serverIntegrationConfig/1", "instanceId": "9f2c4e1a7b3d",
  "stateRules": { "run": ["가동", "run", "1"], "stop": [...], "alarm": [...], "off": [...] },
  "timezone": "Asia/Seoul", "dayStartHour": 8,
  "shifts": [ { "name": "A", "start": "08:00", "end": "20:00" }, { "name": "B", "start": "20:00", "end": "08:00" } ] }
```
Package config `vexplor.packageIntegrationConfig/1`:
```json
{ "schema": "vexplor.packageIntegrationConfig/1",
  "state": { "property": "MachineState", "interfaceName": "PLC1", "rules": null },
  "alarms": [ { "id": "alarm-main", "property": "AlarmActive", "activeWhen": "truthy", "codeProperty": "AlarmCode", "textProperty": null,
               "severity": null, "raiseSamples": 1, "clearSamples": 1, "maintenanceIds": [] } ],
  "counters": [ { "id": "produced", "property": "ProductionCount", "kind": "total", "unit": null, "max": null, "maxRatePerHour": null },
                { "id": "runHours", "property": "CumulativeRunHours", "kind": "runHours", "unit": "h", "max": null, "maxRatePerHour": 1 } ],
  "thresholds": [ { "id": "motor-temp-high", "property": "MotorTemperature", "direction": "above", "limit": 85, "hysteresis": 2,
                    "unit": "degC", "severity": null, "raiseSamples": 2, "clearSamples": 2 } ],
  "suppressProperty": "MaintenanceMode",
  "connection": { "lostAfterFailures": 2 },
  "isa95": { "site": "Changwon", "levels": { "WACE/Line-A": "WorkCenter" } } }
```
`activeWhen`: `"truthy"` (true/1/non-zero/"true") or `{ "equals": ["ALARM", "3"] }`. `kind`: `total|good|reject|runHours|energy|other`. Validation errors → 400 with the JSON path.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/integrations/config` | read | `200 { value, revision }`; defaults filled (`DEFAULT_STATE_RULES`, `Asia/Seoul`, 8) when never saved, `revision: 0` |
| PUT | `/integrations/config` | admin | `If-Match: "<revision>"` required (428 if missing, 412 if stale); body = value; `instanceId` is server-owned (ignored if changed); audit event |
| GET | `/packages/:packageId/integration-config` | read | `200 { value, revision }` or `{ value: null, revision: 0 }`; `ETag` |
| PUT | `/packages/:packageId/integration-config` | edit | `If-Match` (428/412); 400 on validation; audit event |

### 4.4 Exports (read)

All exports: `format=json|csv` (default json); CSV: RFC 4180 via existing `csvCell` (formula-injection safe), CRLF, `.` decimals, ISO dates, multi-values `;`-joined (`;` escaped as `\;`), `bom=1` adds UTF-8 BOM, `headers=keys|ko` (keys are the contract; `ko` labels via `tr()`), `meta=1` adds a first line `#schema=…`. `Content-Disposition: attachment; filename="<schema>-<date>.csv"`. Deterministic ordering (by `key`, then business key) — two exports without edits differ only in `exportedAt`. Language for MLP values: `lang` (default `ko`, fallback `en`, then first).

| Method | Path | Query | Schema / columns |
|---|---|---|---|
| GET | `/integrations/exports/equipment` | `packageId` (optional: all visible), `includeTypes=1`, `trace=1`, `profile=sap-pm` | `vexplor.equipmentMaster/1` (below) |
| GET | `/integrations/exports/bom` | `packageId` (required) | `vexplor.bom/1`; **422** `BomRootMismatch` when INT-2 fails |
| GET | `/integrations/exports/hierarchy` | `packageId` (required, a process file) | `kr.vexplor.aas.hierarchy.v1` |
| GET | `/integrations/exports/maintenance` | `packageId` (required) | `vexplor.maintenancePlan/1` (CSV = one row per step) |
| GET | `/integrations/exports/documents` | `packageId` (required) | `vexplor.documents/1` |
| GET | `/integrations/readiness` | `packageId` (optional) | `200 { "items": [ { "packageId", "checks": [ { "id": "INT-1", "severity": "warning\|error", "message", "pointer"? } ] } ] }` |

Equipment JSON item (one per **Instance** shell; Type shells only with `includeTypes=1` and then flagged):
```json
{ "key": "<globalAssetId>", "aasId": "…", "assetKind": "Instance", "typeAasId": "…|null", "packageId": "pkg_12", "revision": 42,
  "nameplate": { "manufacturer": "…", "productDesignation": "…", "productFamily": "…", "modelNumber": "…", "orderCode": "…",
                 "serialNumber": "…", "yearOfConstruction": "2026", "dateOfManufacture": "2026-03-18", "productUri": "…", "markings": ["…"] },
  "physical": { "weight": { "value": 8500, "unit": "kg" } },
  "location": { "path": ["…"], "isa95": { "site": "…", "area": "…", "workCenter": "…" } },
  "specificAssetIds": [ { "name": "…", "value": "…" } ],
  "externalRefs": [ { "system": "…", "type": "…", "id": "…" } ],
  "sourcePaths": { "nameplate.serialNumber": "DigitalNameplate/SerialNumber" },
  "missing": ["nameplate.productUri"], "warnings": ["sap-pm: productDesignation is 41 chars (> 40)"] }
```
Envelope: `{ "schema": "vexplor.equipmentMaster/1", "exportedAt", "source": { "tool": "VEXPLOR AAS Studio", "version", "instanceId" }, "language", "items": [...], "excluded": [ { "packageId", "reason": "INT-1 …" } ] }`.
`typeAasId` comes from the derivation sidecar (`routes/derivation.ts` `DERIVATION_PART`) when present. `sourcePaths` only with `trace=1`. Units from the element's ConceptDescription (IEC 61360 `unit`), else `null` + key in `missing`. Field lookups: by semanticId first (SerialNumber `0112/2///61987#ABA951#009`, ManufacturerName `0112/2///61987#ABA565#009`, YearOfConstruction `0112/2///61987#ABP000#002` — values from the sample per the ERP report), then by idShort for the rest.

Frozen CSV columns (`apps/api/src/integration/exports/columns.ts`; adding only at the end; changing = schema `/2`):
- `EQUIPMENT_V1_COLUMNS`: `key, aasId, assetKind, typeAasId, packageId, revision, nameplate.manufacturer, nameplate.productDesignation, nameplate.productFamily, nameplate.modelNumber, nameplate.orderCode, nameplate.serialNumber, nameplate.yearOfConstruction, nameplate.dateOfManufacture, nameplate.productUri, nameplate.markings, physical.weight.value, physical.weight.unit, location.path, location.isa95.site, location.isa95.area, location.isa95.workCenter, specificAssetIds, externalRefs, missing, warnings` (`specificAssetIds` = `name=value;…`, `externalRefs` = `system|type|id;…`, `location.path` = `/`-joined).
- `BOM_V1_COLUMNS`: `rootKey, parentPath, childPath, childName, childGlobalAssetId, quantity, level, entityType, erpMaterial, mapped` (quantity = child `BulkCount`, default 1, "per parent"; `erpMaterial` from refs subject `bomChild` type `material`; unmapped rows kept with `mapped=false`).
- `HIERARCHY_V1_COLUMNS`: `id, parentId, equipmentLevel, name, globalAssetId, aasId, packageId, serialNumber, quantity, specificAssetIds, warnings` (flat list; `id` = `/`-joined path; quantity > 1 → warning INT-4, never multiplied into rows).
- `MAINTENANCE_V1_COLUMNS`: `maintenanceId, taskName, interval, intervalStatus, technicians, qualification, safety, stepSeq, stepId, stepName, instruction, durationValue, durationUnit, toolIds, consumableIds, documents, signatureRequired, sourceRef`.
- `DOCUMENTS_V1_COLUMNS`: `documentId, documentDomainId, classId, className, classificationSystem, version, language, title, status, statusDate, issuer, fileName, contentType, size, sha256, available, url`.

Maintenance JSON = the CMMS job-plan shape (cmms §4): `interval: null, intervalStatus: "missing"` unless the model holds an explicit interval value + unit (never inferred); steps in model order; `ReferenceElement`s resolved to tool/consumable ids (unresolvable → `unresolved: [...]`); `signatureRequired` from `DocumentationSignatureMandatory`; `contentHash` (sha256 of the canonical plan). List items are keyed by business keys (`MaintenanceID`, `ToolID`, `ConsumableID`, `DocumentIdentifier`), never by index.
Documents: one row per `Documents[] × DocumentVersions[] × DigitalFiles[]`; `url` = the existing Part 2 attachment route `…/submodels/<b64>/submodel-elements/<idShortPath>/attachment` (absolute with `AAS_PUBLIC_URL`); `size`/`sha256` from `packageFiles`; missing part → `available: false`, `url: null`.

### 4.5 External references

| Method | Path | Auth | Request / response |
|---|---|---|---|
| GET | `/packages/:packageId/external-refs` | read | `200 { "value": ExternalRefsDoc, "revision": n }` + `ETag: "<n>"`; `{ value: {schema, subjects: []}, revision: 0 }` when none |
| PUT | `/packages/:packageId/external-refs` | edit | body `ExternalRefsDoc`; `If-Match` (428/412); 400 validation (system must be non-empty and contain no `|`; `costCenter` cannot have `publish: true`); **409** `ExternalRefConflict` `{ claims: [...] }`; then projection: refs with `publish: true` are written into the package's first AAS `assetInformation.specificAssetIds` as `{ name: "<system>:<type>", value: id, externalSubjectId?: { type: "ExternalReference", keys: [{ type: "GlobalReference", value: externalSubjectId }] } }`; previously managed names (`managedSpecificAssetIds`) no longer published are removed; other specificAssetIds are untouched; done with `updateIdentifiable` under `runWithChange({ cause: 'external-refs' })` so history, undo stack and a `model.shell.updated` event follow. Response `200 { value, revision, projected: { added: [...], removed: [...] } }` |
| POST | `/integrations/external-refs/import` | edit | `?dryRun=1`; body CSV (`text/csv`, columns `globalAssetId,subjectKind,subjectKey,system,type,id,publish,sensitive,externalSubjectId`) or JSON `{ rows: [...] }`; matches packages by `globalAssetId` among visible packages (no match → row error); dry run `200 { "changes": [ { "packageId", "add": [...], "remove": [] } ], "errors": [ { "row": 3, "message" } ], "conflicts": [...] }`; apply returns the same plus revisions; idempotent (second identical import → zero changes). Import only adds/updates refs present in the file; it never deletes others |

Deleting a package that has external refs: the existing delete route is not changed in behaviour, but the UI shows a confirmation (WP5) and the store emits `model.package.deleted`; the projector emits `equipment.master.changed` with `operation: "removed"` (= ERP "retired" signal).

### 4.6 Runtime equipment data (read)

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/integrations/equipment/segments` | `packageId`, `from`, `to` (≤ 31 days) | `200 { "packageId", "property", "ruleSetHash", "holdMs", "segments": [ { "from", "to", "state" } ], "totals": { run, stop, alarm, off, unknown, none } }`; 409 `NoStateTag` when the package config names no state property |
| GET | `/integrations/equipment/oee-inputs` | `packageId`, `from`, `to` **or** `day=YYYY-MM-DD` [`shift=A`] | `200 { "window": { "from", "to", "timezone" }, "runMs", "stopMs", "alarmMs", "offMs", "unknownMs", "noDataMs", "coverage": 0.97, "resolutionMs": 30000, "produced": { "delta": 1234, "resets": 0, "counterId" } \| null, "good": … \| null, "reject": … \| null, "ruleSetHash" }` — never an OEE number |
| GET | `/integrations/meters` | `packageId`, `counter` (id or `runtime`), `from`, `to`, `period=hour\|shift\|day` (default day) | `200 { "readings": [ { "readingId", "assetId", "meterId", "meterKind": "deviceCounter\|computedRunTime", "unit", "reading", "delta", "periodStart", "periodEnd", "observedAt", "receivedAt", "flags": { rollover, reset, gap, implausible, simulated }, "excludedBadSamples", "source", "evidence" } ] }` — `evidence` = `/packages/<id>/values?property=…&from=…&to=…&basis=received`; computed run time adds `runningSeconds, stoppedSeconds, alarmSeconds, offSeconds, unknownSeconds` |
| GET | `/integrations/opcua/certificates` | admin | `200 { "trusted": [ { thumbprint, subject, notAfter } ], "rejected": [...] }`; 409 when OPC UA is off or insecure |
| POST | `/integrations/opcua/certificates/:thumbprint/trust` | admin | `200`; moves a rejected client certificate to trusted via `trustCertificate()`; audit event |

### 4.7 Fixes to existing endpoints

- **Discovery** (`routes/registry.ts` `parseAssetIds` and `/lookup/shells`): an entry without `name` → **400** `"SpecificAssetId.name is required"`; matching is `link.name === want.name && link.value === want.value` (a `globalAssetId` query matches only the AAS `globalAssetId`). `registry.test.ts` gets the two new cases plus "globalAssetId EQ-07 does not match a specificAssetId EQ-07".
- **`/description`**: unchanged (D10).
- **Public base URL**: existing `AAS_PUBLIC_URL` now also feeds `dataschema`, `data.links`, document URLs and `href`s. No new variable.

### 4.8 OpenAPI fragment

`docs/openapi/integration.yaml` (OpenAPI 3.0.3) documents every path in §4.1–§4.6 with request/response schemas referencing the event JSON Schemas. A test (`apps/api/test/integration-openapi.test.ts`) asserts that the set of `paths × methods` in the YAML equals the set of integration routes in `buildRoutes` (parsed with the same minimal YAML reader used by `part2-coverage.mjs`; reuse its parsing approach).

---

## 5. Delivery workers

### 5.1 Layout and lifecycle (`apps/api/src/integration/boot.ts`)

```ts
export interface IntegrationBoot {
  enabled: boolean;
  runtimeDeps: IntegrationRuntimeDeps | undefined;     // passed to createApi -> routes
  onPackageCycle: ((cycle: PackageCycle) => Promise<void>) | undefined; // passed to CollectSupervisor
  status(): IntegrationStatus;
  stop(): Promise<void>;
}
export function startIntegrations(options: {
  store: AasStore; env: NodeJS.ProcessEnv; demo: boolean; dataDir?: string; storeKind: 'memory' | 'folder' | 'postgres';
  publicBaseUrl?: string; collectIntervalMs?: number; opcua?: () => OpcUaPublisher | undefined;
  now?: () => number; random?: () => number; timers?: TimerHost;
}): IntegrationBoot;
```
- Called in `createHttpServer` (server.ts) **before** the supervisor is constructed; supervisor gets `onPackageCycle` when enabled; `createApi` gets `integration: boot.runtimeDeps`.
- Event pruning always runs (even when disabled): hourly, `INTEGRATION_RETENTION_DAYS` (default 30) for events; succeeded deliveries 7 days, dead 30 days. Timers `unref()`.
- Disabled (`INTEGRATIONS` ≠ `on`, or demo): no detector, projector or dispatcher; status says why.
- Shutdown: `process.once('SIGTERM'|'SIGINT')` handler installed only by the `server.js` entry block → `boot.stop()` (stops loops, waits ≤ 5 s for in-flight sends, closes MQTT publishers with DISCONNECT, flushes `integration-state.json`) then `process.exit(0)`. Library use (`createHttpServer` in tests) never installs signal handlers.

### 5.2 Dispatcher (`dispatcher.ts`)

- **Fan-out loop** every 1 s: `readEvents({ after: cursor, limit: 500, includeAudit: false })` → `settledPrefix` → for each enabled subscription whose `types`/`packageIds` match and type is deliverable → `enqueueDeliveries`; cursor saved in runtime state `dispatcher:cursor` (the next run re-reads from `cursor` because enqueue is idempotent).
- **Delivery loop** every 1 s (plus immediate re-run when it claimed a full batch): `claimDeliveries(now, 32, 60_000)`; per-subscription concurrency ≤ 4, global ≤ 16 (excess released by `completeDelivery(retry, nextAttemptAt = now)` without counting the attempt — implement by claiming per subscription in the loop, not globally, [implementer: keep claim limit per call = free slots]).
- Outcome mapping: 2xx → succeeded (reset `consecutiveDead`, set `lastSuccessAt`); network/DNS/TLS error, timeout, 408, 425, 429, 5xx → retry by schedule D8 (`Retry-After` seconds or HTTP date honoured, capped at 1 h); other 4xx → dead; 410 → dead **and** subscription disabled (`disabledReason: "410 from receiver"`); after attempt 12 → dead. Each dead increments `consecutiveDead`; ≥ 50 and no success for 72 h → subscription disabled with reason. Never auto-deleted. Every attempt stores status code, duration, error class (≤ 1 KB, control chars stripped) and resolved IP.
- Subscription deleted while rows in flight → completion is a no-op.
- Inject `now`, `random`, `timers` for tests (pattern of `packages/collector/src/runner.ts` `TimerHost`).

### 5.3 Webhook sender (`webhook.ts`, `signing.ts`)

- `node:http` / `node:https` `request` directly; total deadline 10 s via `AbortSignal.timeout` (`INTEGRATION_TIMEOUT_MS`), connect within it; **no redirects** (3xx = failure, `Location` logged); read ≤ 64 KB of response; body serialized once and the same `Buffer` is signed and sent.
- Headers: `webhook-id: <event id>`, `webhook-timestamp: <unix seconds of this attempt>`, `webhook-signature: v1,<base64 HMAC-SHA256(key, "${id}.${timestamp}.${body}")>` (+ ` v1,<sig with previous secret>` during rotation), `content-type: application/cloudevents+json; charset=utf-8`, `user-agent: VEXPLOR-AAS-Webhook/<PRODUCT_VERSION>`. Secret format `whsec_<base64 of 32 random bytes>`; HMAC key = the decoded bytes. These follow the Standard Webhooks scheme [unverified: confirm header names and the `whsec_` decoding rule against the spec text before freezing; the test vectors in §12 pin our implementation either way].
- `examples/webhook-receiver.mjs` (~80 lines, no deps): verifies signature (both secrets), rejects timestamps outside ±5 min, dedupes ids for 48 h in memory, logs. Docs carry a Java and C# verification snippet.

### 5.4 Egress policy (`egress.ts`) — SSRF

```ts
export interface EgressPolicy { allow: readonly AllowEntry[]; demo: boolean; resolve: (host: string) => Promise<string[]> }
export function egressPolicyFromEnv(env, demo, resolve = dnsResolveAll): EgressPolicy;
export async function checkTarget(url: string, kind: SubscriptionKind, policy: EgressPolicy):
  Promise<{ ok: true; host: string; port: number; address: string; tls: boolean } | { ok: false; reason: string }>;
export function pinnedLookup(address: string): LookupFunction;   // for http.request({ lookup }) and net.connect({ lookup })
```
1. Schemes: webhook `https:`/`http:`; mqtt `mqtt:`/`mqtts:`. Userinfo forbidden for http(s) (400). Hostnames normalized; numeric forms (`2130706433`, `0x7f.1`, octal) parsed by `new URL` → checked as IPs.
2. Resolve once (all A/AAAA); **every** answer must pass; the first passing address is pinned and used for the connection (`servername`/`Host` keep the hostname).
3. Always blocked: `127.0.0.0/8`, `::1`, `0.0.0.0/8`, `::`, `169.254.0.0/16`, `fe80::/10`, multicast `224.0.0.0/4` / `ff00::/8`, broadcast `255.255.255.255`, IPv4-mapped/compatible IPv6 of these (`::ffff:127.0.0.1`), NAT64 `64:ff9b::/96` mapping of these.
4. Private (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`): only when matched by `AAS_INTEGRATION_ALLOW` (comma list of CIDR, IP, hostname, each optionally `:port`).
5. Plain `http:`/`mqtt:` only to allowlisted targets (D17).
6. Ports blocked unless the allow entry names that port: 22, 23, 25, 102, 135, 139, 445, 502, 1433, 1521, 3306, 3389, 5432, 6379, 11211, 27017, 44818.
7. Demo: every target refused (integrations are off in demo anyway).
8. Applied at create/patch (422 with reason) **and** before every attempt (DNS may change).

### 5.5 MQTT publisher (WP2 `packages/fieldbus/src/mqtt-publisher.ts`, used by WP3 `mqtt-sink.ts`)

```ts
export interface MqttPublisherOptions {
  url: string;                       // mqtt(s)://host:port (no userinfo)
  username?: string; password?: string;
  clientId?: string; keepAliveSec?: number;       // default 30
  will?: { topic: string; payload: Buffer; retain: boolean; qos: 0 | 1 };
  connectTimeoutMs?: number; ackTimeoutMs?: number; // default 5000 / 10000
  lookup?: LookupFunction;           // pinned address from egress
  servername?: string;
}
export class MqttPublisher {
  static connect(options: MqttPublisherOptions): Promise<MqttPublisher>;
  publish(topic: string, payload: Buffer, options: { qos: 0 | 1; retain: boolean }): Promise<void>; // QoS1 resolves on PUBACK
  readonly connected: boolean;
  close(): Promise<void>;            // DISCONNECT, rejects pending publishes with 'closed'
}
```
- `mqtt-wire.ts`: `publishPacket(topic, payload, { qos, retain, packetId, dup })` (flags `0x30 | dup<<3 | qos<<1 | retain`, 2-byte packet id when qos 1; keep the old positional signature working for existing callers), `connectPacket({ clientId, keepAlive, username, password, will, cleanSession })`, `readPuback(packet)`.
- Packet ids 1..65535 wrapping, in-flight map, keepalive PINGREQ at `keepAlive/2`, ack timeout rejects the publish (delivery retried by the dispatcher). No in-client reconnect: the sink drops a broken publisher and reconnects on the next claimed delivery (delivery retry schedule is the backoff).
- `mqtt-broker.ts` (test broker): QoS 1 receive with PUBACK, forward to subscribers honouring `+`/`#` wildcards, retained store including zero-length payload deletes, will message on abrupt socket close, CONNECT will flags parsing. Existing QoS 0 behaviour unchanged.
- Sink topics (`options.topicPrefix`, default `vexplor/aas/<instanceId>`; validated: no `+`, `#`, NUL, ≤ 200 chars):
  - `{prefix}/events/{type without "kr.vexplor.aas." prefix}` — full CloudEvent JSON, QoS 1, not retained. Success = PUBACK.
  - when `retainState` and type is `equipment.state.changed.v1`: also `{prefix}/equipment/{base64url(globalAssetId)}/state` retained QoS 1 `{ "state", "since", "eventId" }`.
  - will + online: `{prefix}/status` retained `{"online": true, "since"}` after connect, will `{"online": false}`.
- Signing: MQTT 3.1.1 has no headers; the payload is the CloudEvent itself (no HMAC). Docs say: use `mqtts` + broker ACLs.

### 5.6 Secrets (`secrets.ts`)

AES-256-GCM, `sealed = keyId + ":" + base64(iv(12) | tag(16) | ciphertext)`. Master key source, in order: `AAS_SECRET_KEY` (base64, 32 bytes; invalid → startup error) → folder store: `<AAS_DATA_DIR>/secret.key` (created with mode 0600 on first need; startup log warns that data-folder backups contain it) → memory store: random per process (status `ephemeral`) → Postgres without `AAS_SECRET_KEY`: creating a subscription answers 503 `MasterKeyMissing`. `keyId` = first 8 hex of sha256(key). Secrets never logged, never in audit details (redaction test greps serialized logs, delivery rows and audit events).

---

## 6. Server-side state judgement, alarms, thresholds, counters, OEE inputs

### 6.1 What moves

| Today (browser) | After |
|---|---|
| `apps/web/src/components/collection/states.ts` (pure logic) | `packages/aas-core/src/integration/states.ts` (same functions, value shape generic `{ valueText?: string; valueNumber?: number }`); the web file becomes `export * from '@aas/core'` re-exports so existing imports and `daily-states.test.tsx` keep working |
| `FRESH_WINDOW_MS`, `freshWindowMs` in web `freshness.ts` | defined in core `states.ts`; web `freshness.ts` imports them |
| rules in `localStorage` `aas.stateRules` | server config `stateRules` (+ optional per-package override `state.rules`) |
| state tag picked per browser session | package config `state.property` (UI saves it; `pickStateTag` still suggests) |
| `START_HOUR = 8` | server config `dayStartHour` + `timezone` |

UI behaviour (WP5): `DailyStates` loads `GET /integrations/config` and the package config; editing rules writes `PUT /integrations/config` (admin) — non-admins see rules read-only with a note; choosing a state tag writes the package config (editors). If `localStorage` holds custom rules and the server rules are still the defaults (`revision: 0`), an admin sees a one-click "Move browser rules to the server" banner; after success the local key is removed. The bar keeps being computed client-side with the **same** core functions, the same server rules and the same stored values, so bar and events agree.

### 6.2 Supervisor hook (WP2, `apps/api/src/supervisor.ts`)

```ts
export interface PackageCycle {
  record: PackageRecord; environment: Environment; interfaces: readonly AidInterface[];
  cycle: CycleReport; samples: readonly ValueSample[];   // exactly what the sink stored this cycle
  startedAt: string; finishedAt: string; intervalMs: number;
}
export interface SupervisorOptions { /* existing */ onPackageCycle?: (cycle: PackageCycle) => Promise<void>; now?: () => string }
```
The sink is wrapped to also collect the appended samples; after `runner.runOnce()`, `onPackageCycle` is awaited inside its own try/catch (an error is recorded in `SweepPackageResult.errors` prefixed `integration:` and never breaks collection). Only packages with an AID are visited (unchanged).

### 6.3 Detector (WP2, `apps/api/src/integration/runtime/detector.ts`)

```ts
export class EquipmentDetector {
  constructor(deps: { store: AasStore; join: AssetJoinResolver; isSimulated: (i: AidInterface) => boolean;
                      serverConfig: () => Promise<ServerIntegrationConfig>; now?: () => string });
  onPackageCycle(cycle: PackageCycle): Promise<StoredEvent[]>;
}
```
Per package with a package config (no config → only connection events). State persisted in runtime state key `detector:<packageId>` (package-scoped, deleted with the package), written only when changed:
```ts
interface DetectorState {
  ruleSetHash: string;
  state?: { value: MachineStateOrUnknown; since: string; pending?: { value; count; firstAt } };
  alarms: Record<string, { active: boolean; raisedAt?: string; instanceId?: string; occurrences: number; pendingCount: number; firstAt?: string }>;
  thresholds: Record<string, { open: boolean; since?: string; pendingCount: number; firstAt?: string }>;
  counters: Record<string, { value: number; at: string }>;
  connections: Record<string, { failures: number; lost: boolean; since?: string }>;
}
```
Rules:
- **Sample selection**: per property the latest sample of the cycle (by `receivedAt`, fallback `observedAt`); samples whose `quality` is not good (`undefined` or `/^good/i` counts as good) are ignored for state/alarm/threshold and counted as `excludedBadSamples` for counters.
- **State**: `normalizeState(sample, rules)` (rules = package override or server default) → `run|stop|alarm|off`, else `unknown` (never mapped to stop). Change emits `equipment.state.changed` with previous state/since/duration. First ever observation (no persisted state) records state **without** an event. A `ruleSetHash` change re-evaluates silently (no event for the re-labelling itself, the next real change carries the new hash).
- **Alarms**: active per `activeWhen`; raise after `raiseSamples` consecutive active cycles, clear after `clearSamples` inactive cycles; one open instance per rule; a re-raise while open increments `occurrences` (no new event); `alarmInstanceId` deterministic; `raisedAt` = first qualifying sample time, `detectedAt` = confirming cycle time.
- **Thresholds**: `above`: open when value > limit for `raiseSamples` cycles, close when value < limit − hysteresis for `clearSamples` cycles (`below` mirrored). Non-numeric → ignored.
- **Counters** (`counters.ts`, shared with meters): `to > from` → `delta = to − from`; `to === from` → no event; `to < from` → if `max` set: rollover, `delta = max − from + to + 1`, else `reset: true, delta: null`; `maxRatePerHour` set and `delta > elapsedHours × maxRatePerHour` → `delta: null, implausible: true`; previous good sample older than the fresh window → `gap: true` (delta kept, it is the device's own count). New baseline after reset/implausible.
- **Connection**: per AID interface, `cycle.interfaces[i].error` counts a failure; `lost` after `lostAfterFailures` (default 2) consecutive failures, `restored` on the first success after `lost`. Bad tags alone never trigger `lost`. Endpoint credentials masked.
- **Suppression**: `suppressProperty` truthy → `suppressed: true` on every event of that cycle.
- **Ids**: `eventIdFor(type, globalAssetId ?? packageId, key, occurredAt, value)` → re-processing a cycle yields the same ids → `appendEvents` skips them.
- `detectionResolutionMs` = supervisor `intervalMs`.
- Each event carries the `asset` join block from `deps.join(packageId)` (cached; invalidated by the projector on model events).

### 6.4 Segments, OEE inputs, meters (WP2, `segments.ts`, `oee.ts`, `meters.ts`, `zoned.ts`)

- Segments: `readValues(packageId, { propertyName, from: from − holdMs, to, basis: 'received', limit: 100000 })` → core `stateTimeline` → `stateTotals`; `holdMs = freshWindowMs(collectIntervalMs)`.
- OEE inputs: segment totals (`noDataMs` = `none`), `coverage = 1 − noDataMs / windowMs`, counter deltas over the window via the counter math (kinds `total`→`produced`, `good`, `reject`; absent → `null`), `resolutionMs` = collect interval.
- Day/shift windows: `zoned.ts` computes window starts in `timezone` with `Intl.DateTimeFormat` offset lookup (no deps); `Asia/Seoul` has no DST; DST zones are handled by recomputing the offset at the window start [tested with `Europe/Berlin` boundary].
- Meters: device counters → one reading per period = last good value in the period + delta vs the previous period's last good value with the same flags; `readingId` = `rdg_` + base32(sha256(assetId|meterId|observedAt of the reading sample)); computed run time from segments; `simulated` from the AID interface.

---

## 7. OPC UA server authentication (WP2) — in scope, typings verified

`packages/opcua/src/server.ts` `AasOpcUaServerOptions` gains:
```ts
security?: {
  mode: 'secure' | 'insecure';
  verifyUser?: (username: string, password: string) => Promise<boolean>;  // required for 'secure'
  pkiDir?: string;                                                         // rootFolder of OPCUACertificateManager
};
```
- `secure`: `securityPolicies: [SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep, SecurityPolicy.Aes256_Sha256_RsaPss]`, `securityModes: [MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt]`, `allowAnonymous: false`, `userManager: { isValidUserAsync(username, password, callback) { verifyUser(username, password).then((ok) => callback(null, ok), (e) => callback(e)) } }`, `serverCertificateManager: new OPCUACertificateManager({ rootFolder: pkiDir, automaticallyAcceptUnknownCertificate: false })` (initialized before `new OPCUAServer`).
- `insecure`: current behaviour (node-opcua defaults) — only via `OPCUA_ALLOW_INSECURE=on`.
- Read-only address space unchanged (writes already rejected by `accessLevel: CurrentRead`).
- `verifyUser` (wired in WP3 `boot.ts`/`server.ts`): `store.findUserByLogin` + `verifyPassword` (`apps/api/src/password.ts`), rejects disabled accounts, any role allowed (read-only server), throttled per username with the existing `LoginThrottle` from `session.ts` [verify its API shape; reuse, do not fork].
- PKI folder: `OPCUA_PKI_DIR`, else `<AAS_DATA_DIR>/opcua-pki`, else `./opcua-pki`; created with mode 0700.
- `OpcUaPublisher` (`apps/api/src/publisher.ts`) passes `security` through and exposes `pki(): { list(): Promise<{ trusted; rejected }>; trust(thumbprint: string): Promise<boolean> } | undefined` (reads `rejectedFolder` / `trustedFolder`, computes SHA-1 thumbprints, calls `trustCertificate`) used by `/integrations/opcua/certificates`.
- server.ts startup log: secure mode prints policies and the PKI path; insecure prints the existing "no authentication" warning; secure with zero accounts → not started, message "create an account first or set OPCUA_ALLOW_INSECURE=on". `/opcua-status` adds `security: 'secure' | 'insecure'`.
- Tests (`packages/opcua/test/server-security.test.ts`): anonymous session refused; `SecurityPolicy.None` endpoint absent from `getEndpoints`; wrong password refused; correct password over `Basic256Sha256/SignAndEncrypt` reads a value; untrusted client certificate rejected until trusted [unverified: client options to place the client PKI in a temp folder — node-opcua `OPCUAClient.create({ clientCertificateManager })`; confirm in `node_modules/node-opcua-client` typings; certificate generation may take seconds → `testTimeout: 60_000` for this file]; writes still rejected.

---

## 8. Integration readiness checks (replace the proposed lint rules — D9)

`apps/api/src/integration/exports/readiness.ts` (WP4), pure `(environment, refs?) => ReadinessCheck[]`:

| Id | Severity | Condition | Effect |
|---|---|---|---|
| INT-1 | warning | shell `assetKind: Type` with a non-empty DigitalNameplate `SerialNumber` | excluded from equipment export (listed in `excluded`) unless `includeTypes=1` |
| INT-2 | error | hierarchy entry node `globalAssetId` ≠ the shell's `assetInformation.globalAssetId` | BOM export refused with 422 `BomRootMismatch` naming both ids |
| INT-3 | warning | a `MaintenanceInstructions…` collection has no explicit interval value + unit | maintenance export `intervalStatus: "missing"` |
| INT-4 | warning | hierarchy node with `BulkCount > 1` pointing at one `globalAssetId` | hierarchy export warning; never expanded into invented rows |
| INT-5 | warning | Instance shell without `SerialNumber` | equipment export `missing` includes `nameplate.serialNumber` |

Shown in the Integrations screen "Readiness" tab. The sample `RollFormingMachine_sample.aasx` triggers INT-1 and INT-2 (golden test).

---

## 9. UI — admin "Integrations" screen (WP5)

Constraints: existing shadcn kit (`apps/web/src/drive/ui/kit/*`) and dialog patterns (`components/Accounts.tsx`, `Settings.tsx`); every Korean string through `tr()`/`<T>` with English in `apps/web/src/en.ts`; spacing only via tokens and standard scale (`node scripts/spacing-scan.mjs --check`); comments in English; no new UI library.

Entry: settings menu item "연동 (Integrations)" in `app/headerMenus.ts` shown to admins (and read-only for others: only Exports, Readiness and the pull-feed address). State `showIntegrations` in `app/useViewState.ts`, rendered in `app/Overlays.tsx`.

Files (`apps/web/src/components/integrations/`):
| File | Content |
|---|---|
| `Integrations.tsx` | dialog shell with tabs; loads `/integrations/status` |
| `StatusTab.tsx` | enabled/disabled with the reason and the env var to set, worker state, backlog, dead count, master key source, egress allowlist, OPC UA security, pull-feed URL with copy button |
| `SubscriptionsTab.tsx` | list (name, kind, masked url, types, enabled, stats), create/edit form (types as checklist of the catalogue + prefix field, package filter multiselect, MQTT topic prefix / retain state), secret shown once in a copy box, rotate, test (shows status code, latency, resolved IP, snippet), delete with confirm |
| `DeliveriesPanel.tsx` | per subscription: status filter, table (seq, type, status, attempts, next attempt, last code/error, address), redeliver, replay-from-seq |
| `ExportsTab.tsx` | package picker + buttons for equipment / BOM / hierarchy / maintenance / documents in JSON or CSV (options: UTF-8 BOM, Korean headers, include Types) |
| `ReadinessTab.tsx` | readiness checks per package |
| `RulesTab.tsx` | server state rules + timezone + day start + shifts (admin); per-package: state tag, alarms, counters, thresholds, suppress tag (editor) with If-Match conflict handling (reload prompt on 412) |
| `ExternalRefsTab.tsx` | per package refs table editor (system, type, id, publish, sensitive), CSV import with dry-run diff then apply, conflict (409) display |
| `OpcuaCertsTab.tsx` | trusted / rejected client certificates, trust button |

Also: `components/collection/DailyStates.tsx` (server rules, saved tag, migration banner, day start from server), delete-package confirm text mentions external refs when present (`app/useFileActions.ts` [verify the delete flow location]), `apps/web/src/api/integration.ts` client + `apps/web/src/api.ts` registration, `apps/web/vite.config.ts` adds `integrations` to `API_PATHS`, styles in `apps/web/src/styles/aas.css` (token-only).

Web tests (`apps/web/test/`): `integrations.test.tsx` (renders tabs for admin, read-only for viewer, secret shown once, 412 reload prompt, egress 422 message), `daily-states.test.tsx` updated (server rules used, migration banner), `integration-api.test.ts` (URL building, If-Match headers).

---

## 10. Documentation (WP5)

- `docs/integration.md` (English) and `docs/연동.md` (Korean, same structure):
  1. What integrates how (table MES / ERP / CMMS × pull feed / webhook / MQTT / exports / OPC UA / Part 2) and what this tool never does (no writes into MES/ERP/CMMS, no commands to machines, no OEE number, no costs, no invented intervals/locations/units).
  2. Turning it on: `INTEGRATIONS=on`, `AAS_INTEGRATION_ALLOW`, `AAS_SECRET_KEY`, `AAS_PUBLIC_URL`, retention; demo restriction.
  3. Identity and join keys: `globalAssetId`, Instance vs Type, serial numbers, specificAssetId naming convention (`serialNumber`, `erpAssetNumber`, `cmmsEquipmentId`, `mesResourceId`, `erpMaterialNumber`, `manufacturerPartId`, always with `externalSubjectId`), external refs sidecar and publishing, discovery flow (lookup → descriptor → repository → subscribe), "take the endpoint from the descriptor".
  4. Event catalogue with JSON examples, envelope, ordering/idempotency contract, 410 behaviour, schemas endpoint.
  5. Webhooks: signing, verification snippets (TypeScript, Java, C#), test vectors, retries, dead letters, replay, reference receiver.
  6. MQTT: topics, QoS, retained state, security note (no payload signature → use mqtts + ACLs).
  7. Exports: columns per CSV (frozen lists), encodings, ERP mapping hints (SAP PM / iCube / K-System labels marked "typical, verify per installation"), readiness checks.
  8. Runtime rules: state rules, alarms, counters (reset/rollover/implausible/gap), thresholds with hysteresis, suppression, detection resolution and short-alarm miss (recommend latched PLC counters for alarms shorter than the poll interval), shift calendar, OEE inputs (and why no OEE number), meters for CMMS.
  9. OPC UA security: modes, accounts, PKI folder, trusting a client certificate (UaExpert walkthrough), `OPCUA_ALLOW_INSECURE`.
  10. Network placement (Purdue L3/L3.5/L4; push vs pull), folder store on local disk only.
  11. Acceptance checklist the SI team signs with the customer (join key, rule set hash, shift calendar, delivery mode, secret exchange, test ping).
- `docs/openapi/integration.yaml` (§4.8).
- Edit `docs/usage.md` §8 and `docs/사용법.md` (OPC UA is no longer unauthenticated; link to the integration guide), `README.md` / `README.ko.md` (one feature line + link), `.env.example` and `docker-compose.yml` (new variables, commented), release note section in `CONTRIBUTING`? — no: release notes go in `docs/integration.md` §"Changes in this release" (OPC UA default security change, discovery 400 for missing `name`).

---

## 11. Environment variables (new)

| Variable | Default | Effect |
|---|---|---|
| `INTEGRATIONS` | `off` | `on` starts detector, projector, webhook/MQTT delivery. Ignored (off) in `DEMO_MODE`. Event recording and pull feed work regardless |
| `AAS_INTEGRATION_ALLOW` | empty | Comma list of CIDR / IP / hostname, each optionally `:port`, allowed as private or plain-http/mqtt targets and to unblock listed ports |
| `AAS_SECRET_KEY` | — | base64 32-byte master key for sealing webhook secrets / MQTT credentials. Required with `DATABASE_URL`; folder store falls back to `<AAS_DATA_DIR>/secret.key` |
| `INTEGRATION_RETENTION_DAYS` | `30` | Event log retention (by record time). Succeeded deliveries 7 days, dead 30 days (fixed) |
| `INTEGRATION_TIMEOUT_MS` | `10000` | Webhook total deadline per attempt |
| `OPCUA_ALLOW_INSECURE` | off | `on` = previous unauthenticated OPC UA behaviour |
| `OPCUA_PKI_DIR` | `<AAS_DATA_DIR>/opcua-pki` or `./opcua-pki` | OPC UA certificate store |
| `AAS_PUBLIC_URL` (existing) | — | Now also used for event `dataschema`, links and export URLs |

---

## 12. Test plan

All tests run in `bash scripts/ci.sh` (vitest step) with no network beyond `127.0.0.1`; DNS in egress tests is an injected resolver; clocks/timers/random injected. "U" = unit (pure functions), "I" = integration (in-process store + `createApi` handler, or local node:http / test broker / OPC UA server on port 0), "E" = end-to-end (`createHttpServer` on port 0 with folder store + fake receiver).

| Expert test id | What | Type | Owner WP | File |
|---|---|---|---|---|
| MES A, platform 7.1 (1–10) | store conformance incl. events/deliveries/config/refs/state, scoped | I | WP1 | `packages/store/test/conformance-integration.ts` (+ `scoped.test.ts`) |
| platform 7.2 commit-then-crash | write via store A, reopen folder as store B, start dispatcher → receiver gets exactly one event | I | WP3 | `apps/api/test/integration-dispatcher.test.ts` |
| platform 7.2 torn write | inject failing `rename` → voided event | I | WP1 | `packages/store/test/folder.test.ts` |
| platform 7.2 out-of-order commit | `settledPrefix` with synthetic gaps (young gap holds, old gap passes) + postgres-real case when `DATABASE_URL` set | U (+I skipped without DB) | WP0 / WP1 | `apps/api/test/integration-ids.test.ts`, `postgres-real.test.ts` |
| platform 7.2 migration | v8 → v9 twice; newer refused | I | WP1 | `postgres.test.ts` |
| MES B golden (alarm 15/15 in 10 min) | fake cycles at 1 s with simulator-shaped sequence (alarm 5 s every 40 s) → 15 raised, 15 cleared, pairs share instance id, durations 5 s ± 1 s | U | WP2 | `integration-detector.test.ts` |
| MES B state, restart, duplicate | run→alarm→run = 2 events; constant = 0; restart (new detector, same store) = no spurious event; re-processed cycle → same ids, nothing appended | U/I | WP2 | same |
| MES B counter, CMMS T1–T5 | monotonic sum; rollover with `max` (65530→4 = 10); reset → `delta:null`; implausible; gap; bad quality excluded | U | WP2 | `integration-counters.test.ts` |
| MES B connection, CMMS T11 | 2 failures → one `lost`; success → one `restored`; bad tags alone never `lost`; no alarm event | U | WP2 | `integration-detector.test.ts` |
| MES B unknown value | not in rules → `unknown` | U | WP0 | `packages/aas-core/test/integration-states.test.ts` |
| MES B threshold, CMMS T8–T9 | flapping with raise delay → ≤ 1 open, occurrences counted; 79–81 around 80 band 5 → 1 crossed, 0 returned until < 75 | U | WP2 | `integration-detector.test.ts` |
| CMMS T12 | suppression flag | U | WP2 | same |
| CMMS T17 | simulated flag on virtual PLC interface | U | WP2 | same |
| CMMS T18 | day windows across 08:00 KST; `Europe/Berlin` DST boundary; totals equal the bar's core function | U | WP2 | `integration-oee.test.ts` |
| MES §4 oee-inputs, CMMS SHOULD computed run time | coverage, noData, no OEE field | U/I | WP2 | `integration-oee.test.ts`, `integration-routes-equipment.test.ts` |
| MES C, platform 7.3, CMMS T6–T7 | fake receiver script (200, 500×3 then 200, hang, 429 Retry-After 7, 410, 302 to 169.254…): schedule within jitter bounds, Retry-After honoured & capped, 4xx dead, 410 disables, 12 failures dead, consecutive-dead auto-disable, timeout, no redirect follow, body truncation, kill before `completeDelivery` → same `webhook-id` after lease expiry, concurrency cap, 10 000 pending without unbounded memory (assert claim batch size) | I | WP3 | `integration-webhook.test.ts`, `integration-dispatcher.test.ts` |
| MES D signatures, platform 7.3, CMMS T16 | fixed vectors (secret, id, timestamp, body → expected base64, computed once and frozen in the test and docs); verification with an **independent** implementation written in the test file; tamper body/timestamp/secret rejected; both signatures during rotation; old secret after window rejected; reference receiver dedupes | U | WP3 | `integration-signing.test.ts` |
| platform 7.4 SSRF | table: 127.0.0.1, localhost, [::1], ::ffff:127.0.0.1, 0.0.0.0, 169.254.169.254, fe80::1, 10.0.0.5 (blocked / allowed with allow), 2130706433, mixed public+private answers, rebinding (second lookup private → connection still to pinned first IP), userinfo, file:/gopher:, blocked ports, http to non-allowlisted, demo refusal | U | WP3 | `integration-egress.test.ts` |
| platform 7.5, ERP E-23 | viewer/editor/full key/open mode → 403 on every subscription mutation; admin OK; secret only in create/rotate responses; secret absent from listings, delivery rows, audit events, logs; viewer can read feed and exports, cannot PUT refs (403); no auth with accounts → 401 | I | WP3 (+WP4 for refs) | `integration-permissions.test.ts` |
| MES D schemas | every event produced by WP2/WP3/WP4 scenarios validates against its schema | U | WP3 | `integration-schemas.test.ts` (imports scenario builders exported from WP2/WP4 test helpers `apps/api/test/helpers/integration-scenarios.ts` — owned by WP3; WP2/WP4 add builder functions to their own test files and WP3 imports them) |
| CMMS T19, ERP E-21 | replay from cursor returns the same messages; 410 for pruned cursor | I | WP3 | `integration-feed.test.ts` |
| platform 7.8 | e2e: upload → edit submodel via Part 2 PUT → undo → feed and webhook receive `model.package.created`, `model.submodel.updated` (cause `edit`), `model.submodel.updated` (cause `undo`) in revision order | E | WP3 | `integration-e2e.test.ts` |
| platform 7.6, CMMS SHOULD MQTT | publish waits for PUBACK; wildcard subscriber receives; retained state for late subscriber; zero-length clears; will on abrupt close; wrong credentials → error → delivery retried then dead | I | WP2 (client/broker) + WP3 (sink) | `packages/fieldbus/test/mqtt-publisher.test.ts`, `apps/api/test/integration-mqtt-sink.test.ts` |
| MES E, platform 7.7 | OPC UA security (§7) | I | WP2 | `packages/opcua/test/server-security.test.ts` |
| ERP E-1, E-2, E-5 | golden JSON/CSV for the fixture after making an Instance copy; frozen column constants; deterministic re-export | U | WP4 | `integration-exports-equipment.test.ts` + `apps/api/test/golden/integration/*` |
| ERP E-3 | equipment/BOM/hierarchy JSON validate against committed schemas (same `schema-check.ts`) | U | WP4 | same |
| ERP E-4, E-13 | CSV → `parseCsv` back equals JSON values (Korean, commas, quotes, newlines, `;`); BOM flag; CRLF; formula injection escaped | U | WP4 | `integration-exports-csv.test.ts` |
| ERP E-6 | refs import twice → zero changes on second dry run | I | WP4 | `integration-external-refs.test.ts` |
| ERP E-7, E-8, CMMS T13 | readiness INT-1/INT-2 on the sample; Type excluded; BOM 422 | U | WP4 | `integration-readiness.test.ts` |
| ERP E-9, E-10 | reorder list items / rename entity idShort → keyed rows unchanged, `childGlobalAssetId` stable | U | WP4 | `integration-exports-equipment.test.ts` |
| ERP E-11, E-12 | units from CD / null + missing; MLP language fallback | U | WP4 | same |
| ERP E-14 | sap-pm 41-char description → warning, not truncated | U | WP4 | same |
| ERP E-15, E-16, E-17, E-18 | uniqueness 409 with both claims; stale If-Match 412; publish → `/lookup/shells` finds by `sap-s4:PRD:100:equipment`, unpublish → not found, costCenter never projected; AASX export contains no refs unless published | I | WP4 | `integration-external-refs.test.ts` |
| ERP E-19, E-20 | edit serial → exactly one `equipment.master.changed` with `changedKeys:["nameplate.serialNumber"]` after the 5 s debounce (fake timers); edit live value / thumbnail → no master event | I | WP4 | `integration-projector.test.ts` |
| ERP E-22 | delete package with refs → `equipment.master.changed` `operation: removed` (UI confirmation tested in WP5) | I | WP4 (+WP5) | same |
| CMMS T14 | maintenance plan from fixture: `interval:null`, `intervalStatus:"missing"`, step order, tools/consumables, signature flag | U | WP4 | `integration-exports-maintenance.test.ts` |
| CMMS T15 | documents: each file has URL + matching sha256; missing → `available:false` | I | WP4 | `integration-exports-documents.test.ts` |
| MES D hierarchy | hierarchy JSON/CSV round trip; every WorkUnit has `globalAssetId`; ×quantity warning; ISA-95 override + stale override warning | U | WP4 | `integration-exports-hierarchy.test.ts` |
| AAS §3.3 | discovery name matching and missing-name 400 | I | WP3 | `apps/api/test/registry.test.ts` |
| OpenAPI parity | YAML paths × methods = integration routes | U | WP5 | `apps/api/test/integration-openapi.test.ts` |
| part2-coverage | no extras (all new paths in `EXTENSIONS`) | CI step 5 | WP3 | `scripts/part2-coverage.mjs` |
| i18n / spacing | server and UI text scans | CI steps 9–10 | every WP | — |
| Web | §9 web tests | I (jsdom) | WP5 | `apps/web/test/*` |

Deferred tests (with the deferred features, §14): MES D B2MML XSD, MES F 24 h soak, CMMS T10 subscription-mode 100 % capture (documented miss-rate measurement only: a unit test computes the detected/actual ratio for 5 s alarms at 30 s polling and the doc quotes it), platform 7.6 DUP resend after broker restart (no in-client resend by design; delivery retry covers it — test asserts redelivery instead).

---

## 13. Work packages

Rules for every package: own only the listed files (create = own); comments in English; Korean text through `tr()` with an entry in the package's own dictionary file; no new runtime dependency; `npx tsc -b` and the package's tests pass before hand-off; final merge runs `bash scripts/ci.sh`. All new API-side code lives under `apps/api/src/integration/`. Branch per package from `feat/integration`; merge order in §13.7.

### 13.0 WP0 — Contracts (Phase 0, runs first, merged before anyone else starts coding against it)

Owns:
- NEW `packages/aas-core/src/integration/index.ts`, `events.ts` (type constants `EVENT_TYPES`, `DELIVERABLE_TYPES`, `typeMatches(filter, type)`, payload interfaces of §2.2–2.3, `AssetJoin`, `ElementSource`), `config.ts` (`ServerIntegrationConfig`, `PackageIntegrationConfig`, defaults, `parseServerIntegrationConfig`, `parsePackageIntegrationConfig` returning `{ ok, value } | { ok: false, errors: [{ path, message }] }`, `ruleSetHash` input canonicalisation helper), `states.ts` (moved logic + `FRESH_WINDOW_MS`, `freshWindowMs`), `join.ts` (`AssetJoinResolver` type)
- EDIT `packages/aas-core/src/index.ts` (export `./integration/index.js`)
- EDIT `packages/aas-core/src/i18n/index.ts`; NEW `packages/aas-core/src/i18n/en/integration-core.ts` and **empty** `integration-store.ts`, `integration-runtime.ts`, `integration-api.ts`, `integration-exports.ts` (ownership passes to WP1/WP2/WP3/WP4 after merge)
- NEW `packages/store/src/integration-types.ts` (§3.1, **not** yet added to `AasStore`), `packages/store/src/change.ts` (§3.2), `packages/store/src/integration-memory.ts` (§3.3)
- EDIT `packages/store/src/index.ts` (export the three new files)
- NEW `apps/api/src/integration/ids.ts` (`eventIdFor`, `alarmInstanceIdFor`, `readingIdFor`, base32 encoder, `maskCredentials`, `settledPrefix`, `newChangeSetId`)
- EDIT `apps/web/src/components/collection/states.ts` (re-export from core), `apps/web/src/components/collection/freshness.ts` (import window constants from core)
- NEW tests `packages/aas-core/test/integration-states.test.ts`, `integration-config.test.ts`, `packages/store/test/integration-memory.test.ts`, `apps/api/test/integration-ids.test.ts`

Acceptance: `tsc -b` green; existing `daily-states.test.tsx` and `freshness.test.ts` unchanged and green; `MemoryIntegrationLog` passes its unit tests (events ordering, dedupe, prune, deliveries claim/lease, refs uniqueness); config parsers reject every invalid sample listed in their tests.

### 13.1 WP1 — Store (Phase 1)

Owns: EDIT `packages/store/src/types.ts` (`AasStore extends IntegrationStore`; doc comments), `memory.ts` (compose `MemoryIntegrationLog`, emit model events at every mutating method with actor + change context + owner + package revision, delete package state on `deletePackage`), `folder.ts`, `postgres.ts`, `schema.ts`, `scoped.ts`; NEW `postgres-integration.ts`, `folder-integration.ts`; tests `packages/store/test/conformance.ts` (hook), NEW `conformance-integration.ts`, EDIT `memory.test.ts`, `folder.test.ts`, `postgres.test.ts`, `postgres-real.test.ts`, `scoped.test.ts`; dictionary `i18n/en/integration-store.ts`.
Consumes: WP0 types and `MemoryIntegrationLog`.
Acceptance: §3.7 all green on memory, folder, PGlite; `postgres-real` green when a DB is available; no file in `packages/store/src` over its current size trend without a split (new logic lives in the two new files).

### 13.2 WP2 — Runtime engine and field protocols (Phase 1)

Owns: EDIT `apps/api/src/supervisor.ts`, `apps/api/src/publisher.ts`; NEW `apps/api/src/integration/runtime/{detector.ts, alarms.ts, thresholds.ts, counters.ts, connection.ts, element-ref.ts, segments.ts, oee.ts, meters.ts, zoned.ts}`, `apps/api/src/integration/routes-equipment.ts` (§4.3 config routes and §4.6 segments/oee/meters), `apps/api/src/integration/routes-opcua.ts` (certificate routes); EDIT `packages/collector/src/overlay.ts` + `packages/collector/src/index.ts` only to export the element lookup helper if not already exported; EDIT `packages/fieldbus/src/mqtt-wire.ts`, `mqtt-broker.ts`, `index.ts`; NEW `packages/fieldbus/src/mqtt-publisher.ts`; EDIT `packages/opcua/src/server.ts`, `packages/opcua/src/index.ts`; tests NEW `apps/api/test/integration-detector.test.ts`, `integration-counters.test.ts`, `integration-oee.test.ts`, `integration-routes-equipment.test.ts`, `packages/fieldbus/test/mqtt-publisher.test.ts`, `packages/opcua/test/server-security.test.ts`, EDIT `apps/api/test/supervisor.test.ts`, `packages/fieldbus/test/mqtt.test.ts` (only if broker behaviour assertions change); dictionary `i18n/en/integration-runtime.ts`.
Exports for others: `EquipmentDetector`, `PackageCycle`, `equipmentRoutes(store, deps)`, `opcuaRoutes(deps)`, `MqttPublisher`, `OpcUaPublisher.pki()`, `AasOpcUaServerOptions.security`.
Consumes: WP0 (`states`, config types, `AssetJoinResolver`, ids), store port (tests use `InMemoryStore` after WP1 merge; before that, a test double built on `MemoryIntegrationLog`).
Acceptance: §6, §7 behaviour; tests listed in §12 for WP2 green; existing collector/supervisor/OPC UA/MQTT tests unchanged and green.

### 13.3 WP3 — Delivery, API core and server wiring (Phase 1, finishes in Phase 2)

Owns: NEW `apps/api/src/integration/{cloudevents.ts, schemas.ts, schema-check.ts, signing.ts, secrets.ts, egress.ts, webhook.ts, mqtt-sink.ts, dispatcher.ts, boot.ts, routes.ts, routes-events.ts, routes-subscriptions.ts, deps.ts}`; EDIT `apps/api/src/api.ts` (add `integrationRoutes` to `buildRoutes`; set `runWithChange({ cause, changeSetId })` next to `runAsActor` with cause from route pattern: undo/redo patterns → `undo`/`redo`, `/packages/:packageId/fix` → `fix`, upload/new/clone → `import`, `/packages/:packageId/derivation/apply` → `derivation`, else `edit`; map `ExternalRefConflictError` → 409 in `toErrorResponse`), `api-options.ts` (`integration?: IntegrationRuntimeDeps`), `server.ts` (call `startIntegrations`, pass `onPackageCycle`, OPC UA `security` + `verifyUser`, startup log lines, signal handlers in the entry block), `routes/registry.ts` (discovery fix), `apps/api/src/index.ts` (export what scripts/tests need), `scripts/part2-coverage.mjs` (`EXTENSIONS`); NEW `examples/webhook-receiver.mjs`; tests NEW `apps/api/test/integration-{feed,subscriptions,webhook,signing,egress,dispatcher,permissions,schemas,mqtt-sink,e2e}.test.ts`, `apps/api/test/helpers/integration-scenarios.ts`, EDIT `apps/api/test/registry.test.ts`; dictionary `i18n/en/integration-api.ts`.
`integration/routes.ts` composes: `eventRoutes` + `subscriptionRoutes` (WP3), `equipmentRoutes` + `opcuaRoutes` (WP2), `exportRoutes` + `externalRefRoutes` (WP4). Agreed signature for all: `(store: AasStore, deps: IntegrationRouteDeps) => Route[]` where `IntegrationRouteDeps = { runtime?: IntegrationRuntimeDeps; publicBaseUrl?: string; collectIntervalMs?: number; demo: boolean }` defined in `deps.ts` (WP3 publishes this file in the first day of Phase 1 — it only has types).
Acceptance: §4.1–4.2, §4.7, §5 behaviour; part2-coverage green (no extras); e2e green after all packages merge.

### 13.4 WP4 — Exports, external references, projector (Phase 1)

Owns: NEW `apps/api/src/integration/exports/{nameplate.ts, units.ts, location.ts, join.ts, equipment.ts, bom.ts, hierarchy.ts, maintenance.ts, documents.ts, readiness.ts, columns.ts, csv.ts}`, `apps/api/src/integration/projector.ts`, `apps/api/src/integration/external-refs.ts` (validation, import diff, specificAssetIds projection), `apps/api/src/integration/routes-exports.ts`, `apps/api/src/integration/routes-external-refs.ts`; tests NEW `apps/api/test/integration-exports-{equipment,csv,hierarchy,maintenance,documents}.test.ts`, `integration-readiness.test.ts`, `integration-external-refs.test.ts`, `integration-projector.test.ts`, golden files under `apps/api/test/golden/integration/`; dictionary `i18n/en/integration-exports.ts`.
Exports for others: `createJoinResolver(store, publicBaseUrl?) => AssetJoinResolver & { invalidate(packageId?: string): void }`, `IntegrationProjector` (`start()`, `stop()`, `flushNow()`, runtime-state cursor `projector:cursor`, debounce 5 s per package, digests in runtime state `projector:<packageId>`), `exportRoutes`, `externalRefRoutes`.
Consumes: WP0, store port, linter `hierarchyTree` / `findEntryNode` / `HIERARCHY_SUBMODEL_ID_SHORT`, `csvCell` / `parseCsv` from `@aas/linter`, Part 2 path helpers already exported by `routes/part2.ts` [verify export; if missing, compute the attachment URL with `base64url.ts` + idShortPath without editing part2.ts].
Acceptance: §4.4, §4.5, §8 and the WP4 rows of §12; goldens committed; no fixture contains real company names (`scan-fixture-names.py` scans `tests/fixtures` only; goldens use the existing fixture's anonymised values).

### 13.5 WP5 — UI and documentation (Phase 1 against the API contract, Phase 2 against the merged server)

Owns: NEW `apps/web/src/components/integrations/*.tsx` (§9), `apps/web/src/api/integration.ts`; EDIT `apps/web/src/api.ts`, `apps/web/src/en.ts`, `apps/web/src/app/headerMenus.ts`, `apps/web/src/app/Overlays.tsx`, `apps/web/src/app/useViewState.ts`, `apps/web/src/app/Connected.tsx` (pass the new setter), `apps/web/src/app/useFileActions.ts` (delete confirmation text), `apps/web/src/components/collection/DailyStates.tsx`, `apps/web/src/styles/aas.css`, `apps/web/vite.config.ts`; tests NEW `apps/web/test/integrations.test.tsx`, `apps/web/test/integration-api.test.ts`, EDIT `apps/web/test/daily-states.test.tsx`; docs NEW `docs/integration.md`, `docs/연동.md`, `docs/openapi/integration.yaml`, `apps/api/test/integration-openapi.test.ts`; EDIT `docs/usage.md`, `docs/사용법.md`, `README.md`, `README.ko.md`, `.env.example`, `docker-compose.yml`.
Consumes: §4 API contract (mock `fetch` in web tests), WP3 route table for the OpenAPI parity test.
Acceptance: §9 and §10; `i18n-scan --check` and `spacing-scan --check` green; manual check in the browser after merge (open each tab as admin and as viewer, create a subscription to the reference receiver, export CSV, edit rules) recorded with screenshots in the PR.

### 13.6 Interfaces between packages (frozen in WP0 / WP3 `deps.ts`)

| Producer | Interface | Consumer |
|---|---|---|
| WP0 | `IntegrationStore`, record types, `ExternalRefConflictError`, `runWithChange`, `MemoryIntegrationLog` | WP1, WP2, WP3, WP4 |
| WP0 | `EVENT_TYPES`, payload interfaces, config types + parsers, core `states.ts`, `AssetJoinResolver`, `ids.ts` | WP2, WP3, WP4, WP5 |
| WP2 | `PackageCycle`, `EquipmentDetector`, `equipmentRoutes`, `opcuaRoutes`, `MqttPublisher`, `OpcUaPublisher` security + `pki()` | WP3 |
| WP3 | `IntegrationRouteDeps`, `IntegrationRuntimeDeps` (`deps.ts`), `toCloudEvent` | WP2, WP4, WP5 |
| WP4 | `createJoinResolver`, `IntegrationProjector`, `exportRoutes`, `externalRefRoutes` | WP2 (join), WP3 (boot, routes) |

### 13.7 Phases and merge order

1. **Phase 0** — WP0 → merge into `feat/integration`.
2. **Phase 1** (parallel) — WP1, WP2, WP3, WP4, WP5 on their own branches. WP3 publishes `deps.ts` on day 1. Each runs `npx tsc -b` and its own tests.
3. **Phase 2** (sequential merge, each followed by `bash scripts/ci.sh`): WP1 → WP4 → WP2 → WP3 (wires everything; runs e2e) → WP5 (OpenAPI parity, UI against the real server).
4. **Phase 3** — review: independent review agent over the full diff (security focus: egress, secrets, permissions), fix round, `bash scripts/ci.sh`, commit with the repo's commit conventions, push, PR.

---

## 14. Deferred (LATER) and why

| Item | Source | Why deferred |
|---|---|---|
| B2MML Equipment export | MES SHOULD | Must be XSD-validated in CI; the XSD version and its redistribution licence are unverified. Hierarchy JSON/CSV covers MES master data now |
| Sparkplug B | MES, platform | Needs protobuf encoding and a birth/death state model — a dependency or a large hand-written encoder |
| OPC UA Alarms & Conditions / Events area | MES | Large address-space work; events reach MES through feed/webhook/MQTT now |
| OPC UA subscription-based reading (device-timestamped transitions) | MES, CMMS | Collector redesign (monitored items) — documented: use latched PLC counters for short alarms |
| Per-asset ordered delivery (`ordered: true`) | MES, CMMS, platform | D7; pull feed gives total order |
| `includeContent` fat events, `semanticIds` filter, batch delivery | platform SHOULD | Thin events + re-read cover the need; avoids leaking content across workspaces |
| CA pinning per subscription, static auth header, mTLS | platform SHOULD/LATER | Normal TLS validation covers public/allowlisted HTTPS; needs secret storage UI for PEMs |
| Workspace-owned subscriptions | platform | D18 |
| Per-integration API keys with scopes | MES, ERP | Existing read-only token (`AAS_READONLY_TOKEN`) serves read-only integrations; a key store is a separate feature |
| Lint status change events | platform SHOULD | Needs persisted lint digests; not requested by MES/ERP/CMMS |
| `value.freshness.changed` events | MES SHOULD | Connection events cover the data path; freshness is visible in UI |
| Shift CSV file drop | MES SHOULD | Exports + feed cover it; file drops need a target folder policy |
| MES field ↔ AAS path mapping table | MES SHOULD | Join is by `globalAssetId` / external refs; semanticId mapping stays per integration |
| IDTA Time Series submodel with LinkedSegment | AAS SHOULD | Template semanticIds must be copied from the official AASX (unverified) and KOSMO policy interaction needs checking |
| Discovery write `POST/DELETE /lookup/shells/{aasId}` | AAS SHOULD | External-refs publish already writes specificAssetIds through the editor path with history and undo |
| Advertising SSP-002 read profiles | AAS MUST | D10 — needs the SSP-002 YAMLs vendored to prove the claim |
| BasicEventElement declarations | AAS LATER | Experimental in V3.0; validator acceptance unverified |
| Operation invoke, registry writes | AAS LATER | Safety decision / central registry only |
| ERP-specific adapters (SAP OData/IDoc, iCube API) | ERP LATER | Belong to the integrator, outside core |
| CP949 CSV | ERP | Lossy; UTF-8 with BOM covers Excel |
| ISO 14224 class mapping, criticality | CMMS LATER | Person-maintained data, not derivable |
| 24 h soak (MES F) | MES | Not runnable in CI; a scripted soak (`scripts/integration-soak.mjs`) can follow the release |
| Master-key rotation CLI | platform SHOULD | `keyId` is stored so rotation can be added without migration |
| Folder store integration guarantees on network filesystems | platform | Documented as local-disk only |

---

## WP0 notes — choices where the design left room (2026-10-14)

Recorded by WP0 so WP1–WP5 code against the same reading. Changing any of these is a contract change.

**Core (`@aas/core`, `packages/aas-core/src/integration/`)**
- Payload shapes are `type` aliases, not `interface`s: a type alias has an implicit index signature, so a payload can be
  stored as `StoredEvent.data` (`Record<string, unknown>`) without a cast. Keep it that way when adding `.v2` shapes.
- `EVENT_TYPES` is a keyed object (`EVENT_TYPES.equipmentStateChanged`), with `ALL_EVENT_TYPES` (catalogue order),
  `DELIVERABLE_TYPES` (all except audit and ping), `EventDataMap` / `EventDataOf<T>`, `eventClassOf`, `shortEventType`.
- `typeMatches(filter, type)`: exact or prefix ending in `*`; a filter **without** the `kr.vexplor.aas.` prefix is read as
  if it had it (`equipment.*` = `kr.vexplor.aas.equipment.*`); `*` alone matches everything. `typesMatch(list, type)`:
  undefined or empty list = every type (subscription creation must therefore reject an empty `types` list in the API).
- A `CloudEvent<D>` type lives in core `events.ts` so the web client can type the pull feed; rendering stays in WP3.
- `AssetJoin.globalAssetId` / `aasId` / `assetKind` are nullable (a package without an AAS still emits connection
  events). `AssetJoinResolver = (packageId) => Promise<AssetJoin | null>`; null only for a missing package.
- Config parsers are strict (unknown field = error) and return the complete value with defaults filled. Error `path` is a
  JSON Pointer (`/alarms/0/raiseSamples`, `/` for the root). Defaults: `raiseSamples` / `clearSamples` 1, `hysteresis` 0,
  `activeWhen` `"truthy"`, counter `kind` `"other"`, nullable fields `null`, `lostAfterFailures` 2, `shifts` `[]`.
  Counter id `runtime` is reserved (the meters route uses it for computed run time). A rule word that normalises to the
  same text under two states is rejected. Server config `schema` is required; a missing `instanceId` parses as `''` and
  the API overwrites it with the stored id.
- `ruleSetHashInput(rules)` returns canonical text (states in fixed order, words normalised, de-duplicated, sorted); the
  API computes `ruleSetHash = "sha256:" + hex(sha256(text))` (hashing needs `node:crypto`, core stays browser-safe).
  `effectiveStateRules(server, pkg)` picks the package override.
- Also exported from core `states.ts`: `MachineStateOrUnknown`, `MACHINE_STATES`, `STATE_MATCH_ORDER`,
  `normalizeStateWord`, `StateValue`. The web files re-export by name (not `export *`) so the web module surface is unchanged.

**Store (`packages/store/src/`)**
- `EventPage.oldestSeq` / `lastSeq` describe the whole retained log, unfiltered (`lastSeq` 0 when empty).
- `readEvents` clamps `limit` into 1..1000 instead of throwing (the API validates and answers 400 first).
- `enqueueDeliveries` skips rows of unknown subscriptions (PostgreSQL: insert with `WHERE EXISTS`, not an FK error).
- `completeDelivery` changes only the delivery row; resetting `consecutiveDead` / setting `lastSuccessAt` is the
  dispatcher's job through `updateSubscription`. `last*` fields describe the last attempt only (absent = cleared).
  An unknown delivery id is a no-op.
- `SubscriptionPatch`: a key present with `undefined` removes that optional field (`disabledReason: undefined`).
- `deliveryStats` returns one entry per subscription, also with zero deliveries; `oldestPendingAt` = `createdAt` of the
  oldest pending or in-flight row. `listDeliveries` cursor = id of the last returned row, newest first.
- Revisions: `expectedRevision: 0` means "never saved" (matches `revision: 0` of the GET defaults). Re-putting the same
  external-refs doc does not conflict with itself and still increments the revision (the general revision rule).
- External-ref conflicts include two subjects of the same doc claiming one key; `claims` lists the existing claim then
  the new one. The conflict check runs after the revision check and writes nothing.
- `putPackageIntegrationConfig`, `putExternalRefs`, `putRuntimeState(…, packageId)` throw `NotFoundError` for an unknown
  package (PostgreSQL must map its FK violation to it).
- `MemoryIntegrationLog(ownerOf, { maxEvents, now, newId })`; `ownerOf` returns owner string / undefined (no owner) /
  null (missing). `recordModelEvent` returns `undefined` for a duplicate id. `snapshot()` is versioned (`version: 1`) and
  JSON-safe; `restore()` rebuilds the ref key index from the docs.
- Store-level change helpers: `runWithChange`, `currentChange`, and `changeFields()` (mirror of `actorFields`).
- The `ExternalRefConflictError` message key sits in `i18n/en/integration-core.ts` (WP0's dictionary), so the other four
  dictionaries start empty; the server scan rejects a key defined in two files, so WP1 must not repeat it.

**API (`apps/api/src/integration/ids.ts`)**
- `settledPrefix(rows, after, now, settleMs = 30_000)` takes the cursor `after` explicitly (§2.4 text needs it) and
  `now` in epoch ms; a gap passes only when the row after it is **older than** `settleMs` (exactly `settleMs` still holds).
- `eventIdFor(type, subject, key, occurredAt, value)` hashes `canonicalJson([type, subject, key, occurredAt, value])`
  (sorted keys, unambiguous field boundaries). `alarmInstanceIdFor` / `readingIdFor` hash the `|`-joined input of §2.3 / §6.4.
  All ids are prefix + 26 Crockford base32 chars of sha256.
- `newChangeSetId()` = `chg_` + 16 hex (64 random bits; the 8-hex example in §2.1 would collide too often).
- `maskCredentials` replaces the password up to the **last** `@` of the authority (passwords may contain `@`) and keeps
  everything else byte-for-byte; also exported: `base32Encode`, `canonicalJson`.
