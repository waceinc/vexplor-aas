# Integration foundation for vexplor-aas — platform and security opinion

Reviewer role: integration-platform / security engineer. Independent opinion. No repository file was edited.
Repo read at `~/Documents/GitHub/vexplor-aas`, branch `chore/english-comments`, 2026-10-14.
Priority tags: **MUST** (first release of integration), **SHOULD** (next), **LATER**.
Anything I could not confirm from the code or from a spec in hand is marked [unverified].

---

## 0. What the code base gives us today (facts that shape the design)

| Area | What exists | Consequence |
| --- | --- | --- |
| Store port | `AasStore` in `packages/store/src/types.ts`; `InMemoryStore` (memory.ts), `FolderStore extends InMemoryStore` (folder.ts, rewrites `pkg_N/model.json` via temp+rename, appends `values.jsonl`), `PostgresStore` (postgres.ts, `withTransaction`, history pushed inside the same tx as the update); `ScopedStore` (scoped.ts) hand-implements the port for workspaces | An outbox **inside the store** is possible in all three, but the atomicity mechanism differs per store (see §2). ScopedStore must be extended by hand. |
| Schema | `SCHEMA_SQL` + `MIGRATIONS` up to version 8 (`collected_value.received_at`), idempotent ALTERs, newer-DB refusal | New tables go in as **version 9**, same rules. |
| Change context | `runAsActor` (store/src/actor.ts, AsyncLocalStorage) set once in `createApi` (apps/api/src/api.ts) | The same mechanism can carry a `changeSetId` / cause (`undo`, `fix`, `import`) to every event without touching thirty call sites. |
| Undo | `UndoStack` (apps/api/src/undo.ts) restores by calling normal `update/create/deleteIdentifiable` | Undo needs no special event code; events fall out of the store calls. Tag the cause via context. |
| Collection | `CollectSupervisor` (apps/api/src/supervisor.ts) sweeps every `COLLECT_INTERVAL` s, sink = `store.appendValues`; `CycleReport` per interface | Natural emission point for collection **status transitions**; values themselves should not go to webhooks. |
| Lint | `/packages/:packageId/lint` computed on demand; no persisted lint state | A lint event needs a persisted last-result digest; not a MUST. |
| MQTT | `mqtt-wire.ts` builds CONNECT/SUBSCRIBE/PUBACK/PING and `publishPacket()` **QoS 0 only (no packet id)**. `MqttReader` is **subscribe-only**. `MqttTestBroker`: QoS 0, retained, **exact-match topics only (no wildcards)**, accepts client PUBLISH without PUBACK | A publisher needs ~150 lines: QoS 1 PUBLISH with packet id, PUBACK tracking, DUP resend, will message, reconnect. Test broker needs QoS 1 + PUBACK. |
| OPC UA | `AasOpcUaServer` (packages/opcua/src/server.ts) constructs `OPCUAServer` with no `securityModes`/`securityPolicies`/`userManager`/`allowAnonymous` → node-opcua defaults; server.ts refuses it in demo mode because "no authentication" | Auth can be added through constructor options only (§5). |
| Auth | Roles admin/editor/viewer; API keys `full`/`read-only` with `timingSafeEqual`; open when no tokens and no accounts | Integration management must require **admin session**, and must be refused (not silently open) when the server is in open mode. |
| Outbound guard | `guardOutbound` + `demoOutboundAllowed` (security.ts) — demo blocks everything except the simulator; on-prem allows everything | Webhook SSRF policy should extend this one place, not create a parallel one. |
| Retention | `startRetention` hourly prune of `collected_value` (retention.ts) | Reuse for event and delivery-log pruning. |

---

## 1. Event model

### 1.1 Envelope — MUST

Adopt **CloudEvents 1.0, JSON structured mode**. MES/ERP integration middleware (and most iPaaS) already parse it; it costs nothing to follow.

```json
{
  "specversion": "1.0",
  "id": "01JA2W6K6Z8Q4M8V7Y3E1N5T0C",
  "type": "kr.vexplor.aas.submodel.updated",
  "source": "urn:vexplor-aas:<instanceId>",
  "subject": "packages/pkg_12/submodels/aHR0cHM6Ly9leGFtcGxlLmNvbS9zbS8x",
  "time": "2026-10-14T03:12:44.120Z",
  "datacontenttype": "application/json",
  "dataschema": "https://<server>/schemas/events/submodel.updated/1.json",
  "sequence": "000000000000004711",
  "vxpackageid": "pkg_12",
  "vxrevision": 37,
  "vxchangeset": "req_01JA2W6K...",
  "vxcause": "edit",
  "data": {
    "modelType": "Submodel",
    "id": "https://example.com/sm/1",
    "idShort": "TechnicalData",
    "semanticId": "https://admin-shell.io/ZVEI/TechnicalData/Submodel/1/2",
    "packageRevision": 37,
    "identifiableRevision": 5,
    "operation": "update",
    "actor": { "id": "u_3", "name": "Kim" },
    "links": { "self": "/packages/pkg_12/submodels/aHR0cHM6Ly9leGFtcGxlLmNvbS9zbS8x" }
  }
}
```

Decisions:

- **id**: ULID or UUIDv7 (time-sortable). It is the idempotency key the receiver dedupes on, and it is the same across all retries.
- **sequence**: global monotonic number from the store (§2), zero-padded string per CloudEvents sequence extension.
- **subject**: Part 2 style path with **base64url-encoded AAS id** (apps/api/src/base64url.ts already exists). Never put raw AAS ids in paths or topics — they contain `/ # + :`.
- **Thin events by default**: identifiers, revisions, operation, actor, link. **Not the content.** Reasons: AAS submodels can be MB-sized; content may contain data a subscriber's workspace may not read; receivers that act on "latest state" should GET the resource anyway. Offer `includeContent: true` per subscription as SHOULD, capped (e.g. 256 KB, else omit and set `data.contentOmitted = "size"`).
- **Schema version**: the version lives in `type`'s `dataschema` URL (`.../1.json`). Additive changes keep the version; breaking changes create a new `type` suffix (`...updated.v2`) and both are emitted during a deprecation window. Publish JSON Schemas for every type under `GET /schemas/events/...` (SHOULD).
- Extension attribute names must be lowercase alphanumeric per CloudEvents, hence `vxpackageid`, not `vx_package_id`.

IDTA note: the AAS metamodel has `BasicEventElement` and IDTA has work on standardized AAS event payloads [unverified: exact document number and status]. Keep `type` names in our own reverse-DNS namespace so a later IDTA mapping can be added as a separate `type` without breaking existing subscribers.

### 1.2 Event types catalogue

| Type (`kr.vexplor.aas.` prefix) | Priority | Emitted where | Notes |
| --- | --- | --- | --- |
| `package.created` | MUST | store `importPackage` (all three) — covers upload, `/packages/new`, clone | `data`: name, owner, counts per modelType |
| `package.deleted` | MUST | store `deletePackage` | |
| `package.metadata.updated` | SHOULD | `/packages/:id/metadata` route → store call that renames | |
| `shell.created` / `.updated` / `.deleted` | MUST | store `createIdentifiable` / `updateIdentifiable` / `deleteIdentifiable` when modelType = AssetAdministrationShell | |
| `submodel.created` / `.updated` / `.deleted` | MUST | same, modelType = Submodel | This is the event MES/CMMS care about most |
| `conceptdescription.created` / `.updated` / `.deleted` | SHOULD | same, modelType = ConceptDescription | |
| `package.file.updated` / `.deleted` | LATER | `putPackageFile` / `deletePackageFile` | thumbnails, bundle files |
| `collection.interface.status.changed` | MUST | `CollectSupervisor` after each cycle — only on **transition** (ok → failing, failing → ok, pending → receiving) | Not per cycle. Requires remembering last status per (package, interface) in supervisor memory; a restart may emit one redundant "ok". |
| `collection.values` | LATER (and prefer MQTT) | supervisor sink | Per-cycle batch; webhooks are the wrong transport for time series. Use the MQTT connector (§4). |
| `lint.status.changed` | SHOULD | background lint after a package changeset commits (debounced), emitted only if error/warning counts or rule set digest differ from last persisted result | Needs a persisted `lint_digest` per package (column on `aas_package` or a small table in v9). |
| `integration.ping` | MUST | `POST /integrations/webhooks/:id/ping` | Never written to the outbox; delivered directly, logged as a delivery |
| `integration.subscription.*` | SHOULD | integration routes | Written to the event log for audit (§6) but **not deliverable** to subscriptions |

### 1.3 Where to emit — exact code points

1. **Model changes: inside the store, not in the API dispatcher.** The dispatcher in `createApi` (api.ts, after `undo.commit`) runs *after* the store transaction committed, so a crash there loses the event; and many writes do not go through the HTTP dispatcher (startup template import in server.ts, `UndoStack.undo/redo`, derivation sidecars, scripts). Emitting in the store methods guarantees every committed change has exactly one event.
   - postgres.ts: in `createIdentifiable` / `updateIdentifiable` / `deleteIdentifiable` inside the existing `withTransaction(... async (tx) => ...)`, next to `pushHistory(tx, ...)`; in `importPackage` inside its transaction; in `deletePackage`.
   - memory.ts: in the same methods after the state mutation, synchronously (no `await` between mutation and outbox push).
   - folder.ts: see §2.3 for ordering against `persist()`.
2. **Change context**: add to `packages/store/src/actor.ts` (or a sibling `context.ts`) a `ChangeContext { actor?, changeSetId?, cause? }` carried by the same AsyncLocalStorage. `createApi` sets `changeSetId` = request id and `cause` from the route (`edit`, `fix`, `import`, `undo`, `redo`, `restore`, `derivation`). `UndoStack.undo/redo` sets `cause` explicitly. The store reads it when building the event; nothing else changes.
3. **Collection status**: `apps/api/src/supervisor.ts`, after a cycle completes, diff each interface's result against the previous cycle and call `store.recordEvents([...])` (new port method, §2.2) for transitions only.
4. **Lint**: new `apps/api/src/integration/lint-watch.ts` that listens for committed changesets (in-process notification from the dispatcher, §2.4), debounces 2 s per package, runs the linter, compares with stored digest, records `lint.status.changed`. Losing this on crash is acceptable (the next change recomputes) — it is derived data, not a source change.

### 1.4 Ordering — MUST be documented, not over-engineered

- **Within a package**: `vxrevision` (package revision) is strictly increasing per committed change. This is the ordering key receivers should use.
- **Globally**: `sequence` is monotonic in commit-ish order but **not guaranteed gap-free** (PostgreSQL sequences skip on rollback).
- **Delivery order is not guaranteed** once retries happen. Do not implement strict per-subscription head-of-line ordering in the first release: one flaky MES endpoint would stall everything behind it in a factory. Contract for receivers: *"dedupe on `id`; ignore an event whose `vxrevision` is lower than the one you already applied for that package; when in doubt, GET the resource."* An optional `ordered: true` per subscription (per-package FIFO, blocks only that package) is LATER.

---

## 2. Transactional outbox vs in-memory queue

### 2.1 Recommendation: transactional outbox in the store port — MUST

An in-memory queue loses every event in the window between commit and delivery and on every restart — exactly the case MES/ERP integrators complain about ("we missed a change and our BOM diverged"). The store already has transactions (postgres) and an atomic-rename write path (folder), so an outbox is cheap here. The in-memory store keeps its outbox in memory, which is fine because the in-memory store loses the model too.

Additionally, the outbox gives a **pull feed for free** (`GET /integrations/events?after=`) — this is the most important integration for air-gapped plants where the AAS server may not open connections into the MES network (§3.9).

### 2.2 Port additions (packages/store/src/types.ts)

Keep `AasStore` cohesive by adding a section, not a second port (ScopedStore and conformance stay one place):

```ts
export interface IntegrationEvent {
  seq: number;              // assigned by the store
  id: string;               // ULID/UUIDv7, assigned by the store if absent
  type: string;
  occurredAt: string;
  packageId?: string;
  subject?: string;
  packageRevision?: number;
  owner?: string;           // copied from the package — for workspace filtering
  actorId?: string; actorName?: string;
  changeSetId?: string; cause?: string;
  data: Record<string, unknown>;
}

export interface WebhookSubscription {
  id: string; name: string; kind: 'webhook' | 'mqtt';
  url: string;                       // https://... or mqtt(s)://...
  types: string[];                   // exact or prefix with trailing '*'
  packageIds?: string[];             // empty = all visible packages
  enabled: boolean; disabledReason?: string;
  includeContent: boolean;
  owner?: string;                    // workspace; absent = server-wide (admin)
  secretHint: string;                // last 4 chars only
  createdAt: string; updatedAt: string; createdBy?: string;
}

export interface DeliveryRecord {
  id: string; subscriptionId: string; eventSeq: number; eventId: string;
  status: 'pending' | 'in-flight' | 'succeeded' | 'dead';
  attempts: number; nextAttemptAt: string; leaseUntil?: string;
  lastStatusCode?: number; lastError?: string; lastDurationMs?: number;
  createdAt: string; updatedAt: string;
}

// AasStore additions
recordEvents(events: readonly Omit<IntegrationEvent, 'seq'>[]): Promise<IntegrationEvent[]>;  // non-model events
readEvents(afterSeq: number, limit: number, scope?: PackageScope): Promise<IntegrationEvent[]>;
pruneEvents(before: string): Promise<number>;

listSubscriptions(scope?: PackageScope): Promise<WebhookSubscription[]>;
getSubscription(id: string): Promise<(WebhookSubscription & { secretSealed: string }) | undefined>;
createSubscription(input: NewSubscription & { secretSealed: string }): Promise<WebhookSubscription>;
updateSubscription(id: string, patch: SubscriptionPatch): Promise<WebhookSubscription | undefined>;
deleteSubscription(id: string): Promise<boolean>;

enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[]): Promise<number>; // idempotent
claimDeliveries(now: string, limit: number, leaseMs: number): Promise<DeliveryRecord[]>;   // due + lease
completeDelivery(id: string, result: DeliveryResult): Promise<void>;  // succeeded | retry(nextAt) | dead
listDeliveries(subscriptionId: string, query?: { status?: string } & PageQuery): Promise<PageResult<DeliveryRecord>>;
redeliver(deliveryId: string, now: string): Promise<boolean>;         // resets to pending, attempts kept
getCursor(name: string): Promise<number>;  setCursor(name: string, seq: number): Promise<void>;
pruneDeliveries(before: string): Promise<number>;
```

Model events are **not** recorded through `recordEvents`; they are written internally by the mutating methods so they cannot be forgotten.

### 2.3 Per-store atomicity

**PostgreSQL** — MUST. `INSERT INTO integration_event` in the same `tx` as `pushHistory`. Rollback (e.g. `ConflictError`) drops the event automatically.

**Folder** — MUST, needs care because `persist()` rewrites `pkg_N/model.json` via temp+rename and there is no cross-file transaction. Proposed protocol:
1. Append the event line to `<dir>/events.jsonl` (`appendFile`, then `fsync` of the fd) **before** `writeModel` renames the new `model.json`.
2. Rename `model.json` (existing code).
3. On `init()`, after loading all packages, scan `events.jsonl`: any event whose `packageRevision` is **greater than** the loaded package's revision (or whose package does not exist for a non-delete event) belongs to a write that never landed → write a tombstone line `{"void": "<id>"}` and never expose it.
   This gives no lost events and no phantom events. `seq` = line counter persisted in `events.meta.json` or recomputed at init from the last line.
   Delivery state (`deliveries.jsonl` append-only status lines, compacted at init) and `subscriptions.json` (temp+rename like `users.json`) live next to `users.json`.
   [unverified] fsync durability on a Synology Drive / SMB-backed folder: rename atomicity and fsync semantics over network filesystems are weaker; document "folder store on a local disk only" for integration guarantees.

**Memory** — arrays in the instance; `seq` counter. No durability (same as the model).

**ScopedStore** — subscription methods filter by `owner` exactly like packages: a workspace sees its own subscriptions; server-wide subscriptions (`owner` absent) are admin-only. `readEvents(scope)` returns events for the owner's packages **plus shared (ownerless) packages**, mirroring the read rule in scoped.ts.

### 2.4 Migration version 9 (packages/store/src/schema.ts) — MUST

```sql
CREATE TABLE IF NOT EXISTS integration_event (
  seq             bigserial PRIMARY KEY,
  id              text NOT NULL UNIQUE,
  type            text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  package_id      text,
  subject         text,
  package_revision integer,
  owner           text,
  actor_id        text,
  actor_name      text,
  change_set_id   text,
  cause           text,
  data            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS integration_event_time ON integration_event (occurred_at);
CREATE INDEX IF NOT EXISTS integration_event_pkg  ON integration_event (package_id, seq);

CREATE TABLE IF NOT EXISTS integration_subscription (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'webhook',
  url             text NOT NULL,
  types           text[] NOT NULL DEFAULT '{}',
  package_ids     text[] NOT NULL DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT true,
  disabled_reason text,
  include_content boolean NOT NULL DEFAULT false,
  owner           text,
  secret_sealed   text NOT NULL,          -- AES-256-GCM, see §6
  secret_previous_sealed text,            -- during rotation
  secret_previous_until  timestamptz,
  secret_hint     text NOT NULL,
  key_id          text NOT NULL,          -- which master key sealed it
  created_by      text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_delivery (
  id              bigserial PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES integration_subscription(id) ON DELETE CASCADE,
  event_seq       bigint NOT NULL,
  event_id        text NOT NULL,
  status          text NOT NULL,          -- pending | in-flight | succeeded | dead
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  lease_until     timestamptz,
  last_status_code integer,
  last_error      text,
  last_duration_ms integer,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (subscription_id, event_seq)
);
CREATE INDEX IF NOT EXISTS integration_delivery_due ON integration_delivery (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS integration_cursor (
  name text PRIMARY KEY,
  seq  bigint NOT NULL
);
```

Follow the existing rule: add to `SCHEMA_SQL`, add the same idempotent block as `MIGRATIONS` version 9, bump `SCHEMA_VERSION`. No foreign key from `integration_event.package_id` to `aas_package` — the package may be deleted while events are still pending (and the store's philosophy already avoids enforcing integrity that defective data would break).

`claimDeliveries` in Postgres: `UPDATE ... SET status='in-flight', lease_until=now()+lease WHERE id IN (SELECT id FROM integration_delivery WHERE status IN ('pending','in-flight') AND next_attempt_at <= $now AND (lease_until IS NULL OR lease_until < $now) ORDER BY next_attempt_at LIMIT $n FOR UPDATE SKIP LOCKED) RETURNING *`. Expired leases recover crashed workers; multiple API instances are safe.

### 2.5 The outbox pitfall that must be handled: sequence visibility

With `bigserial`, transaction T1 may take seq 10 and T2 seq 11; if T2 commits first, a fan-out reader that sees 11 and advances its cursor past 10 **silently loses event 10**. This is the classic transactional-outbox bug. Mitigation (MUST, simple): the fan-out worker scans `seq > cursor - overlap` **and** `occurred_at > now() - 30 s` re-scan window, relying on the `UNIQUE (subscription_id, event_seq)` constraint to make re-enqueueing idempotent (`INSERT ... ON CONFLICT DO NOTHING`). Alternative for strictness (SHOULD on PG13+): store `pg_current_xact_id()` and only advance past rows with `xid < pg_snapshot_xmin(pg_current_snapshot())` [unverified: minimum PostgreSQL version deployed for this product]. Include a postgres-real test that commits out of order (§7).

### 2.6 Worker layout (apps/api) — MUST

```
apps/api/src/integration/
  dispatcher.ts   fan-out loop (events -> deliveries) + delivery loop (claim -> send -> complete)
  webhook.ts      HTTP sender: sign, timeout, no redirects, SSRF-pinned lookup
  mqtt-sink.ts    MQTT publisher target (§4)
  signing.ts      Standard Webhooks sign/verify (also exported for receivers' tests)
  secrets.ts      seal/unseal with master key
  routes.ts       /integrations/* (admin only)
```

Start it in server.ts like `CollectSupervisor`/`startRetention`, behind `INTEGRATIONS=on` (default off — same philosophy as `COLLECT` and `OPCUA_SERVER`). Inject `now()` and a `TimerHost` (the pattern already exists in `packages/collector/src/runner.ts`) and a `random()` for jitter so tests can use a fake clock. The dispatcher also gets an in-process "kick" (EventEmitter) from the store/dispatcher after commits so latency is ~ms, with a 2 s poll as the safety net.

---

## 3. Webhook subscriptions

### 3.1 API shape — MUST (all under admin; see §6)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/integrations/webhooks` | body `{name, url, types[], packageIds?, includeContent?, enabled?}` → `201` with `secret` **returned once** (`whsec_` + base64 of 32 random bytes) |
| `GET` | `/integrations/webhooks` | list, `secretHint` only |
| `GET` / `PATCH` / `DELETE` | `/integrations/webhooks/:id` | PATCH may change url/types/packages/enabled; changing `url` re-runs the SSRF check |
| `POST` | `/integrations/webhooks/:id/rotate-secret` | returns new secret once; old secret stays valid for 24 h (both signatures sent) |
| `POST` | `/integrations/webhooks/:id/ping` | synchronous test delivery of `integration.ping`; returns status code, duration, first 1 KB of body, and the resolved IP |
| `GET` | `/integrations/webhooks/:id/deliveries?status=&cursor=&limit=` | delivery log |
| `POST` | `/integrations/deliveries/:id/redeliver` | manual redelivery (resets to `pending`, same event id) |
| `POST` | `/integrations/webhooks/:id/replay` | body `{fromSeq}` or `{from}` (time) — re-enqueue a range; SHOULD |
| `GET` | `/integrations/events?after=<seq>&limit=&types=` | **pull feed**; readable by `read-only` API keys too (scoped by workspace) — MUST |
| `GET` | `/integrations/status` | worker running, backlog size, oldest pending age, dead count per subscription |

Filtering: `types` entries are exact (`kr.vexplor.aas.submodel.updated`) or prefix wildcards (`kr.vexplor.aas.submodel.*`). `packageIds` empty = all packages visible to the subscription owner. A SHOULD extension is `semanticIds[]` (fire only for submodels with that semanticId) — CMMS integrations typically only want e.g. maintenance-related submodels.

### 3.2 Signature — MUST

Use the **Standard Webhooks** scheme (published spec with libraries in many languages, which matters for MES/ERP teams writing receivers in C#/Java) [unverified: confirm current spec revision before freezing]:

```
webhook-id:        <event id>           (same on every retry)
webhook-timestamp: <unix seconds>       (time of THIS attempt)
webhook-signature: v1,<base64(HMAC-SHA256(secretBytes, `${id}.${timestamp}.${rawBody}`))>
Content-Type:      application/cloudevents+json; charset=utf-8
User-Agent:        VEXPLOR-AAS-Webhook/<version>
```

- During rotation send both: `webhook-signature: v1,<sigNew> v1,<sigOld>`.
- Receivers must reject timestamps outside **±5 minutes** (replay window) and dedupe on `webhook-id` for at least the retry horizon (~48 h).
- Sign the exact bytes sent; serialize once, sign, send the same buffer.
- Factory clocks drift. Put the server time in the ping response and in `/integrations/status` so a receiver rejecting on timestamp can be diagnosed; recommend NTP in the install guide.
- SHOULD: optional per-subscription static header (e.g. `Authorization: Bearer ...`) for receivers behind an API gateway that cannot verify HMAC; stored sealed like the secret. LATER: mTLS client certificate.

### 3.3 Retry, backoff, dead-letter — MUST

- Success: any `2xx`.
- Retry on: connection error, DNS failure, TLS error, timeout, `408`, `425`, `429` (honour `Retry-After`, capped at 1 h), `5xx`.
- No retry (dead immediately): other `4xx`. `410 Gone` additionally **disables the subscription** (`disabledReason = "410 from receiver"`).
- Schedule (attempt n → delay): 0, 10 s, 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h, 8 h, 8 h → **12 attempts, ~40 h**, so a weekend plant shutdown of the MES is partially covered and a long one lands in dead-letter for manual replay.
- Jitter: "equal jitter" — `delay * (0.8 + 0.4 * random())`; random injected for tests.
- Dead-letter = `status='dead'` rows in `integration_delivery` (no separate table needed); visible in the delivery log, redeliverable individually or by replay.
- Auto-disable a subscription after **N consecutive dead deliveries (e.g. 50) and no success for 72 h**, with `disabledReason`; surface it on the admin screen. Never auto-delete.
- Concurrency: at most 4 in-flight requests per subscription (avoid hammering a small MES), global cap 32.

### 3.4 Timeouts and HTTP client hardening — MUST

- `node:http(s).request` directly (no new dependency), total deadline **10 s** (connect 5 s), `AbortSignal.timeout`.
- **Do not follow redirects** (treat 3xx as failure with the `Location` logged) — redirects are the cheapest SSRF bypass.
- Read at most 64 KB of the response body, store at most 1 KB in `last_error`/log; strip control characters.
- `https` with normal certificate validation; per-subscription `caCertificate` (PEM) as SHOULD, because factory MES often uses an internal CA. Never offer "ignore TLS errors" as a toggle without an admin-only, loudly labelled option [recommend: do not offer it at all].
- Payload size cap (1 MB); if `includeContent` would exceed, send thin.

### 3.5 SSRF — targets in private ranges are legitimate in factories

Threat: an editor (or a compromised account) points a webhook at `169.254.169.254` (cloud metadata), `127.0.0.1:5432`, the PLC's web UI, or uses DNS rebinding. Policy (MUST):

1. Only `admin` can create or change a target (§6). That alone removes the "any user" vector.
2. Scheme allowlist: `https`, `http`, `mqtt`, `mqtts`. No `file:`, no userinfo in URL for HTTP.
3. **Always blocked**, regardless of settings: loopback `127.0.0.0/8`, `::1`; unspecified `0.0.0.0/8`, `::`; link-local `169.254.0.0/16`, `fe80::/10` (cloud metadata lives here); multicast/broadcast; IPv4-mapped/compatible IPv6 forms of the above (`::ffff:127.0.0.1`), NAT64 `64:ff9b::/96` mapped equivalents.
4. **Private ranges** (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`): allowed only when the server setting `AAS_INTEGRATION_ALLOW` lists the CIDR or host explicitly, e.g. `AAS_INTEGRATION_ALLOW=10.20.0.0/16,mes.plant.local`. Default for an on-prem install wizard: prompt the admin for the MES/ERP subnet. Default in demo mode: **nothing private, nothing at all except public HTTPS** (extend `demoOutboundAllowed` / `guardOutbound`, do not fork a second policy).
5. **Resolve once, check all A/AAAA answers, then connect to the checked address**: pass a custom `lookup` to `http.request` that returns the pre-validated IP, keep `servername`/`Host` as the hostname for TLS SNI and virtual hosts. This defeats DNS rebinding between check and connect.
6. Optional port allowlist (SHOULD): reject well-known database/admin ports (22, 23, 3389, 5432, 3306, 6379, 502 Modbus, 44818 EtherNet/IP, 102 S7) unless explicitly allowed — they are never webhook receivers and are exactly what an attacker probes on an OT network.
7. Log the resolved IP for every delivery.
8. Same checks apply to the MQTT broker URL and to the OPC UA browse endpoint path that already uses `guardOutbound`.

### 3.6 Delivery log — MUST

Per attempt the row keeps status code, duration, error class, resolved IP, attempt number. Request body is not duplicated (it is reconstructible from the event + subscription at the time); response bodies truncated. Retention: succeeded deliveries 7 days, dead 30 days, events 30 days (configurable), pruned by the existing hourly retention timer.

### 3.7 Test ping — MUST

`integration.ping` is signed exactly like real events so the receiver can validate their verification code end-to-end. It bypasses the outbox (nothing to persist) but writes a delivery row with `event_seq = 0`-style marker [or a separate `kind` column] so it appears in the log.

### 3.8 Idempotency guidance for receivers — MUST (documentation)

At-least-once is the contract. Receivers dedupe on `webhook-id` (= CloudEvents `id`) and apply by `vxrevision`. Provide a reference receiver in `examples/` (Node, ~60 lines) and a verification snippet for C# (common in Korean MES vendors) [unverified: which receiver stacks the three target vendors use].

### 3.9 Air-gapped / segmented networks

- In ISA-95 / Purdue layouts, the AAS server typically sits at L3 (with MES) or in an L3.5 DMZ; ERP is at L4. Outbound L3→L4 push is often permitted, inbound L4→L3 pull is often blocked; the reverse can also be true. **Ship both push (webhook/MQTT) and pull (`/integrations/events`)** so the plant's firewall policy, not our product, decides.
- No internet dependency anywhere in the delivery path (no hosted webhook relays, no external schema fetch at runtime).
- `dataschema` URLs should point at the AAS server itself so they resolve inside an air-gapped network.

---

## 4. MQTT publish connector

### 4.1 Client choice — SHOULD

Extend the existing dependency-free client rather than adding `mqtt` (MIT, but large and with its own reconnection semantics) — the codebase deliberately avoids dependencies and already has the wire helpers. Work needed in `packages/fieldbus/src`:

- `mqtt-wire.ts`: `publishPacket(topic, payload, { qos, retain, packetId, dup })` (QoS 1 adds the 2-byte packet id; header flags `0x30 | dup<<3 | qos<<1 | retain`), CONNECT with **will** flags/topic/payload, PUBACK reader.
- new `mqtt-publisher.ts`: connect, keepalive (existing pattern), in-flight map `packetId → {resolve, payload}`, resend with DUP on reconnect, reconnect backoff 1 s → 60 s with jitter, `publish()` returns a promise resolved on PUBACK (QoS 1) — **that PUBACK is the delivery success signal** for the outbox row.
- `mqtt-broker.ts` (test broker): add QoS 1 + PUBACK, and `+`/`#` wildcard matching so tests can subscribe to the scheme below.
- MQTT 3.1.1 is enough for the first version. MQTT 5 (user properties for CloudEvents attributes, message expiry, content-type) is LATER.

Use the same subscription table with `kind='mqtt'` and the same delivery machinery: one subscription = one broker connection; at most one in-flight window (e.g. 16) per broker.

### 4.2 Topic scheme — SHOULD

Prefix configurable per subscription (`enterprise/site/area/aas` in UNS style). AAS ids and idShorts are base64url-encoded in topic levels.

| Topic | Retained | QoS | Payload |
| --- | --- | --- | --- |
| `{prefix}/events/{eventType}` | no | 1 | full CloudEvent JSON (same as webhook body) |
| `{prefix}/packages/{pkgId}/state` | **yes** | 1 | `{ "revision": 37, "name": "...", "updatedAt": "...", "lint": {...} }` |
| `{prefix}/packages/{pkgId}/submodels/{b64id}/state` | **yes** | 1 | `{ "revision": 5, "idShort": "...", "semanticId": "...", "updatedAt": "..." }`; on delete publish a **zero-length retained message** to clear it |
| `{prefix}/packages/{pkgId}/values/{interface}/{property}` | yes | 0 or 1 | `{ "value": 42.1, "observedAt": "...", "receivedAt": "...", "quality": "Good" }` — LATER, from the supervisor sink, not via the outbox |
| `{prefix}/status` | yes (will) | 1 | `{"online": true, "since": ...}`; will message `{"online": false}` |

Retained state topics give late-joining MES clients the current picture without a replay — this is where MQTT beats webhooks.

### 4.3 Sparkplug B — LATER

Sparkplug B needs protobuf encoding, NBIRTH/DBIRTH/NDEATH lifecycle, sequence numbers, and a primary-host state model; it is designed for device data, not model-change notifications. Only consider it for the `values` stream if a customer's SCADA/historian requires it. Do not block the integration release on it.

---

## 5. OPC UA server authentication (node-opcua)

Realistic with constructor options only, in `packages/opcua/src/server.ts` `new OPCUAServer({...})` [unverified: exact option names against the installed node-opcua 2.178 typings — confirm before coding]:

- `securityPolicies: [SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep, SecurityPolicy.Aes256_Sha256_RsaPss]` — **drop `None`** when auth is on.
- `securityModes: [MessageSecurityMode.SignAndEncrypt]` (optionally `Sign`).
- `allowAnonymous: false` when accounts exist.
- `userManager: { isValidUserAsync: async (user, pass) => ... }` that calls the same password verification as `apps/api/src/password.ts` against `store.findUserByLogin`, rejects disabled accounts, and is rate-limited per remote address (reuse the login throttle if one exists) [unverified: whether a login throttle exists in routes/auth.ts]. Read-only server, so any active account (viewer included) may read; no write permissions to map.
- Separate option: dedicated OPC UA service accounts (`role: viewer`, login `opcua-mes`) so MES does not use a person's password.
- PKI: node-opcua creates a self-signed server certificate and a PKI folder with `trusted` / `rejected` client certificates [unverified: exact folder layout]. Set `automaticallyAcceptUnknownCertificate: false`; provide an admin screen or CLI to move a rejected client cert to trusted. This is the step integrators always stumble on — document it with screenshots.
- Put the PKI folder under the data folder so it survives updates; `0700` permissions.
- With these in place, the demo-mode refusal in server.ts can stay (demo is public internet; still do not expose 4840 there).
- X.509 user identity tokens — LATER.

Priority: SHOULD for the integration release (MES that reads via OPC UA is a primary customer path; today the only defence is "internal network only").

---

## 6. Admin, permissions, secrets, audit

- **Who**: managing subscriptions, secrets, replay, redelivery, OPC UA trust list — **admin session only** (`Principal.role === 'admin'`). API keys of level `full` must **not** manage integrations (they are shared, long-lived, often pasted into scripts). `read-only` keys and viewers may read the pull feed `/integrations/events` within their workspace scope.
- **Open-mode servers** (no tokens, no accounts): refuse integration management with a clear message ("create an admin account first"). An open server with outbound webhooks is an SSRF and data-exfiltration relay.
- **Workspaces** (`AAS_WORKSPACE=private`): a subscription created in a workspace only receives events for that workspace's packages plus shared packages (same visibility rule as reading). Server-wide subscriptions only by admin.
- **Secrets: encrypt, do not hash.** HMAC signing needs the plaintext key at send time, so hashing is impossible. Use AES-256-GCM with a master key:
  - Postgres deployments: `AAS_SECRET_KEY` (32 bytes, base64) from env / secret manager; refuse to create webhooks if absent.
  - Folder / installed edition: generate `<dataDir>/secret.key` on first use with `0600`; warn that backups of the data folder contain the key.
  - Store `key_id`; support re-sealing with a new key (`--rotate-master-key` CLI) — SHOULD.
  - Never return the secret after creation; show `secretHint` (last 4). Never log it; add a redaction test.
- **Audit**: there is no generic audit table today (history covers identifiables only). Write `integration.subscription.created/updated/deleted/secret-rotated/redelivered/replayed` events with actor into `integration_event` (non-deliverable types), and show them on the integration admin screen. This reuses the outbox as an append-only audit log at zero extra schema cost.
- **Rate of change**: PATCH of `url` should require re-entering the admin password or at least re-confirmation in UI — SHOULD (a hijacked admin session redirecting all change events is the most valuable attack).

---

## 7. Test plan

All tests in the existing test runner; no network beyond `127.0.0.1`.

### 7.1 Store conformance (packages/store/test/conformance.ts, `describeStore`) — MUST, runs for memory, folder, postgres (fake client) and postgres-real

1. `createIdentifiable` / `updateIdentifiable` / `deleteIdentifiable` / `importPackage` / `deletePackage` each produce exactly one event of the right type with the resulting `packageRevision`.
2. `updateIdentifiable` with a wrong `expectedRevision` (ConflictError) produces **no** event.
3. Events carry actor from `runAsActor` and changeSet/cause from the change context.
4. `readEvents(after)` is ordered by seq, respects `limit`, and with `scope` returns only own + shared packages.
5. `enqueueDeliveries` is idempotent (same pair twice → one row).
6. `claimDeliveries` never returns the same row to two concurrent callers within the lease; an expired lease is reclaimable.
7. `completeDelivery` transitions: retry sets `next_attempt_at`, dead is terminal, `redeliver` resets.
8. Subscriptions CRUD; `secretSealed` round-trips byte-exact; `listSubscriptions` never exposes it.
9. `pruneEvents` / `pruneDeliveries` remove only older rows.
10. ScopedStore (scoped.test.ts): a workspace cannot list/get/update another workspace's subscription; cannot read another workspace's events.

### 7.2 Durability / crash — MUST

- **Commit then crash before delivery**: write through store A, do not start dispatcher, discard A; open store B on the same folder dir / database; start dispatcher → receiver gets exactly one event.
- **Folder torn write**: append event line, then simulate crash before `model.json` rename (inject a failing `rename`); re-init → event voided, never delivered; model unchanged.
- **Out-of-order commit (postgres-real)**: two transactions, T1 takes the lower seq but commits after T2; assert the fan-out delivers both (catches §2.5).
- **Migration**: an existing v8 database upgrades to v9 idempotently (run migration twice), and a v9 DB is refused by v8 code (existing behaviour, add a case).

### 7.3 Webhook sender — MUST

- Fake receiver: `node:http` server on port 0 with a scripted response queue (`200`, `500`, hang, `429 Retry-After: 7`, `410`, `302 Location: http://169.254.169.254/`), recording raw body and headers.
- Signature: verify with an **independent** implementation in the test (not the production `signing.ts`), plus fixed test vectors (fixed secret, id, timestamp, body → expected base64); tampered body, tampered timestamp, wrong secret, old secret after rotation window → reject; both signatures present during rotation.
- Backoff with fake clock + seeded random: the attempt schedule matches the table within jitter bounds; `Retry-After` honoured and capped; 4xx → dead; 410 → subscription disabled; 12 failures → dead; consecutive-dead threshold → auto-disable.
- Timeout: receiver that never answers → attempt fails at the deadline (fake clock or a short configured deadline), lease released.
- Redirect not followed; response body truncated; payload over cap sent thin.
- **Duplicate delivery**: receiver returns 200 but the worker is killed before `completeDelivery` (inject throw) → after lease expiry the event is redelivered with the **same** `webhook-id`; the reference receiver dedupes it.
- Concurrency cap per subscription respected.

### 7.4 SSRF — MUST

Table-driven over the validator and the pinned `lookup`: `127.0.0.1`, `localhost`, `[::1]`, `::ffff:127.0.0.1`, `0.0.0.0`, `169.254.169.254`, `fe80::1`, `10.0.0.5` (blocked unless in `AAS_INTEGRATION_ALLOW`), decimal/octal IP forms (`http://2130706433/`), hostname resolving to both a public and a private IP (blocked), DNS rebinding (first lookup public, second private → connection still goes to the first validated IP), userinfo in URL, `file:`/`gopher:` schemes, blocked ports. Demo mode: every private target refused.

### 7.5 Permissions — MUST

Viewer / editor / `full` API key / open mode → `403`/refusal on every `/integrations/webhooks*` mutation; admin succeeds; secret appears only in the create and rotate responses; the delivery log never contains the secret (grep the serialized log in the test).

### 7.6 MQTT — SHOULD

Extend `MqttTestBroker` with QoS 1 + PUBACK + wildcards; tests: publish waits for PUBACK; broker restart mid-stream → reconnect with backoff and DUP resend, no loss; retained state topic readable by a late subscriber; delete clears retained topic; will message published on abrupt disconnect; broker refuses credentials → delivery retried, then dead.

### 7.7 OPC UA auth — SHOULD

Anonymous session refused when accounts exist; wrong password refused; disabled account refused; `SecurityPolicy.None` endpoint absent; untrusted client certificate rejected until moved to trusted [unverified: node-opcua client test harness specifics].

### 7.8 End-to-end smoke — SHOULD

Server with `INTEGRATIONS=on`, folder store, fake receiver: upload package → edit submodel via Part 2 PUT → undo → expect `package.created`, `submodel.updated` (cause `edit`), `submodel.updated` (cause `undo`) in revision order.

---

## 8. Prioritised build order

| # | Item | Priority |
| --- | --- | --- |
| 1 | Event envelope + catalogue (model events) + change context in actor.ts | MUST |
| 2 | Store outbox: port methods, schema v9, three implementations, ScopedStore, conformance tests, crash tests | MUST |
| 3 | Pull feed `GET /integrations/events` | MUST |
| 4 | Dispatcher (fan-out with re-scan window, claim/lease, retry/backoff, dead-letter, pruning) | MUST |
| 5 | Webhook sender: Standard Webhooks signing, timeouts, no redirects, SSRF policy with pinned lookup and `AAS_INTEGRATION_ALLOW` | MUST |
| 6 | Admin-only routes, sealed secrets, rotation, ping, delivery log, redeliver, audit events | MUST |
| 7 | Collection status transition events | MUST |
| 8 | OPC UA server auth (username/password, Basic256Sha256 SignAndEncrypt, PKI trust) | SHOULD |
| 9 | MQTT publisher (QoS 1, retained state, will, reconnect) on the existing client | SHOULD |
| 10 | Lint status events, `semanticIds` filter, `includeContent`, CA pinning, JSON Schemas endpoint, replay by range | SHOULD |
| 11 | Ordered per-package delivery, MQTT 5, value streaming over MQTT, Sparkplug B, mTLS, X.509 OPC UA users | LATER |

Main risks to watch: (a) the sequence-visibility gap in §2.5; (b) the folder store on network filesystems; (c) SSRF on OT networks where "private" is the normal case — the admin-only + explicit allowlist + pinned resolution trio is what makes it safe; (d) receivers that do not dedupe — ship the reference receiver.
