# VEXPLOR AAS Studio — MES integration: independent expert opinion

Reviewer role: MES integration architect (ISA-95 / IEC 62264, B2MML, OPC UA, ISO 22400, Korean SME plants).
Scope read: README.md, docs/usage.md §6–§8 and §12, apps/api/src/routes/*.ts (route patterns), packages/opcua/src (server.ts, publish.ts),
packages/collector/src (runner.ts), packages/store/src/types.ts, apps/web/src/components/collection/{DailyStates.tsx,states.ts}.
No repository file was edited. Anything I am not certain of is marked **[unverified]**.

---

## 0. Verdict in one paragraph

The tool already has the hardest part MES vendors usually lack: a *typed, standard-addressed* equipment model (AAS + AID) with
a company → line → process → equipment hierarchy keyed by `globalAssetId`. What it lacks is the **event layer**: an MES does not
want to poll `$value?live=true`; it wants "machine X went to ALARM at 10:41:07, here is a stable id you can dedupe on". Today that
judgment (run/stop/alarm/off) is computed **in the browser** (`apps/web/.../states.ts`, rules kept in `localStorage`), so the
server cannot emit it, and two screens with different rules give two different answers. The single most important change is to move
state derivation server-side, persist events in a store-backed **event log (outbox)**, and expose that one log through a pull
cursor feed first and webhooks second. Everything else (B2MML, MQTT, Sparkplug, OPC UA A&C) is a projection of that log.

---

## 1. Integration patterns MES actually use with an equipment-data layer

| Pattern | Who uses it (practice) | Fit for this tool | Priority |
|---|---|---|---|
| **Pull REST with a cursor** (`GET /events?after=<seq>`) | Most Korean SME MES (in-house or package MES built on Spring/.NET + Oracle/MSSQL); they already run scheduler jobs that poll | Trivial on node:http, no deps, survives MES downtime by design (MES just resumes from its last cursor). Equivalent of the domestic "I/F table" habit | **MUST (first)** |
| **Webhook push** (HTTP POST, signed) | Newer/cloud MES, iPaaS, low-code (n8n etc.) | Needs outbox + retry dispatcher; built on the same log | **MUST (second)** |
| **Pull REST for current/master data** (Part 2 `$value?live=true`, `/packages/{id}/values`, hierarchy) | All | Already there — needs stable asset-level addressing (see §3) | Already there; harden |
| **OPC UA subscribe** | Global MES/SCADA (Siemens Opcenter, Rockwell, AVEVA, Critical Manufacturing) and SCADA layers | Already there (port 4840/4841, read-only, **no auth**). Add security first; add an `Events/` folder or Alarms & Conditions later | SHOULD (auth); LATER (A&C) |
| **MQTT publish (plain JSON)** | UNS-style architectures, global plants, IIoT platforms | collector already speaks MQTT as a client (no external lib); publishing the same event JSON to topics is small | SHOULD |
| **MQTT Sparkplug B** | SCADA-centric UNS (Ignition etc.) | Needs protobuf encoding + birth/death/sequence semantics → a dependency or a hand-written encoder | LATER |
| **File / batch** (CSV drop to a shared folder, SFTP) | Very common in Korean SMEs and with legacy MES ("put a CSV in \\\\server\\if\\ every 10 min") | Cheap: a daily/shift CSV of state segments and counters + hierarchy CSV. Already have CSV export habit | SHOULD (shift CSV) |
| **DB staging table** (tool writes into MES's interface table) | Very common domestically | Do **not** write into customer DBs from the product (credentials, schema drift, liability). Offer the cursor feed; the SI team writes the 30-line poller into the I/F table | NOT IN PRODUCT (document recipe) |
| **MES → equipment commands** (recipes, orders, start/stop) | — | Out of scope by design (read-only, Option A). Say so explicitly in docs so nobody expects it | NEVER (in this tool) |

Order of delivery: **event log → cursor feed → webhooks → OPC UA security → MQTT JSON → shift CSV → B2MML → Sparkplug / OPC UA A&C.**

---

## 2. Event types and payloads

### 2.1 Common envelope

Use the **CNCF CloudEvents 1.0 JSON format** as the envelope — it is a plain JSON convention (no dependency), widely understood by
integration platforms, and gives `id` / `source` / `type` / `time` / `subject` semantics for free.

```json
{
  "specversion": "1.0",
  "id": "evt_01JAB3...  (deterministic, see §5.2)",
  "source": "urn:vexplor-aas:server:<instanceId>",
  "type": "kr.vexplor.aas.equipment.state.changed.v1",
  "time": "2026-10-14T01:41:07.312Z",
  "subject": "https://example.com/ids/asset/press-03",
  "datacontenttype": "application/json",
  "sequence": 184223,
  "data": { "...": "type-specific, below" }
}
```

Every `data` carries the same **join block** (`asset`) so an MES can match on whatever key it already has:

```json
"asset": {
  "globalAssetId": "https://example.com/ids/asset/press-03",
  "aasId": "https://example.com/ids/aas/press-03",
  "specificAssetIds": { "SerialNumber": "SN-2024-00317", "MesEquipmentCode": "PRS-03" },
  "serialNumber": "SN-2024-00317",
  "packageId": "pkg_8f2c...",
  "path": ["WACE", "Line-A", "Pressing", "Press-03"],
  "isa95": { "site": "Changwon", "area": "Line-A", "workCenter": "Pressing", "workUnit": "Press-03" }
}
```

Rules for the join block:
- `globalAssetId` is the **primary key** (it is already the link used by the hierarchy route).
- `serialNumber` comes from the Digital Nameplate submodel (IDTA 02006, property `SerialNumber`) when present; omit, never invent.
- `specificAssetIds` is where the customer's **MES equipment code** lives. This is the field Korean MES teams will actually join on.
  Make it editable in the UI and lint it (unique within a server). This is the cheapest high-value feature in this whole list.
- `packageId` is an internal id: include it for debugging but document it as "not stable across re-imports".
- `path` / `isa95` come from the process file's hierarchy (§3). If an equipment is in no hierarchy, send `path: []` and `isa95: null`.

Element references always use **Part 2 addressing**: `submodelId` + `idShortPath` (the OPC UA NodeIds already mirror idShortPath,
so REST, OPC UA and events then all name a value the same way).

### 2.2 Event catalogue

| type (suffix of `kr.vexplor.aas.`) | When | Priority |
|---|---|---|
| `equipment.state.changed.v1` | normalized state (run/stop/alarm/off/unknown/none) changes | MUST |
| `equipment.alarm.raised.v1` / `equipment.alarm.cleared.v1` | an alarm tag becomes active / inactive | MUST |
| `equipment.counter.advanced.v1` | production counter increases (batched per cycle) | MUST |
| `connection.lost.v1` / `connection.restored.v1` | an AID interface fails / recovers | MUST |
| `value.freshness.changed.v1` | a tag goes live → stale → none (the "no data" the daily bar already shows) | SHOULD |
| `value.threshold.crossed.v1` | user-defined limit crossed (with hysteresis) | SHOULD |
| `model.changed.v1` | an Identifiable (AAS/Submodel/CD) was created/updated/deleted (revision bump) | SHOULD |
| `hierarchy.changed.v1` | an equipment node attached/detached/moved in a process file | SHOULD |
| `collection.config.changed.v1` | AID changed (address list changed) | LATER |

**equipment.state.changed.v1**
```json
"data": {
  "asset": { "...join block..." },
  "state": "alarm",
  "previousState": "run",
  "previousStateSince": "2026-10-14T01:12:40.002Z",
  "previousDurationMs": 1707310,
  "rawValue": "3",
  "source": { "submodelId": "https://.../sm/OperationalData", "idShortPath": "MachineState", "aidProperty": "MachineState" },
  "ruleSetId": "rules:pkg_8f2c:v4",
  "observedAt": "2026-10-14T01:41:06.900Z",
  "receivedAt": "2026-10-14T01:41:07.300Z",
  "quality": "Good",
  "detectionResolutionMs": 30000
}
```
`detectionResolutionMs` = collection interval. This is honest metadata: with polling, the transition happened somewhere in the
last interval. MES teams need this to judge whether micro-stops are measurable at all.

**equipment.alarm.raised.v1 / cleared.v1**
```json
"data": {
  "asset": { "...": "..." },
  "alarmKey": "AlarmActive",
  "alarmInstanceId": "alm_<hash(globalAssetId|alarmKey|raisedAt)>",
  "code": "E-217",
  "text": "Hydraulic pressure low",
  "severity": null,
  "raisedAt": "2026-10-14T01:41:06.900Z",
  "clearedAt": null,
  "durationMs": null,
  "source": { "submodelId": "...", "idShortPath": "AlarmActive" }
}
```
`cleared` repeats the same `alarmInstanceId` with `clearedAt` and `durationMs`, so the MES can pair them without state of its own.
`severity` is null unless the device provides one — do not invent severities.

**equipment.counter.advanced.v1**
```json
"data": {
  "asset": { "...": "..." },
  "counterKey": "ProductionCount",
  "counterKind": "total",
  "from": 15230, "to": 15241, "delta": 11,
  "intervalStart": "2026-10-14T01:40:37Z", "intervalEnd": "2026-10-14T01:41:07Z",
  "reset": false,
  "source": { "submodelId": "...", "idShortPath": "ProductionCount" }
}
```
`counterKind`: `total` | `good` | `reject` — only what the model actually names (e.g. a separate `GoodCount` tag). Rollover/reset
detection: if `to < from`, emit `reset: true`, `delta: null` and let the MES decide; do not guess the wrap value unless the AID/model
states a max (then `delta = max - from + to + 1`). One event per collection cycle per counter, never per piece.

**connection.lost.v1 / restored.v1**
```json
"data": {
  "asset": { "...": "..." },
  "interfaceName": "OPCUA_Main",
  "endpoint": "opc.tcp://192.168.0.50:4840",
  "protocol": "opcua",
  "error": "connect ECONNREFUSED",
  "since": "2026-10-14T01:41:07Z",
  "consecutiveFailures": 3
}
```
Debounce: emit `lost` only after N consecutive failed cycles (default 2), `restored` on the first success after that. The runner
already isolates per interface (`CycleReport.interfaces[].error`), so this is a small diff on `onCycle`.
Mask credentials in `endpoint` (MQTT URLs carry `user:password@`).

**value.threshold.crossed.v1**
```json
"data": {
  "asset": { "...": "..." },
  "ruleId": "thr_motor_temp_high",
  "source": { "submodelId": "...", "idShortPath": "MotorTemperature" },
  "direction": "above",
  "limit": 85.0, "hysteresis": 2.0,
  "value": 86.4, "unit": "degC",
  "observedAt": "..."
}
```
Rules stored server-side per package; hysteresis mandatory (otherwise a noisy sensor floods the MES).

**model.changed.v1**
```json
"data": {
  "packageId": "pkg_8f2c...",
  "modelType": "Submodel",
  "id": "https://.../sm/TechnicalData",
  "operation": "update",
  "revision": 42,
  "actor": { "id": "apikey:full", "name": "..." },
  "href": "/packages/pkg_8f2c.../api/v3.0/submodels/<b64url>"
}
```
Carry a link, not the body — MES re-reads via Part 2. `HistoryRecord` already captures exactly these fields.

Publish a **JSON Schema per event type** at `GET /events/schemas/{type}` and in the repo (tests validate against it, see §7).
Version via the `.v1` suffix; additive fields only within a version.

---

## 3. Equipment hierarchy for MES master data

### 3.1 Mapping to ISA-95 (IEC 62264-1) role-based equipment hierarchy

ISA-95 levels: Enterprise → Site → Area → Work center (process cell / production unit / production line / storage zone) →
Work unit (unit / work cell / storage unit). Equipment below work unit (equipment modules, control modules) is outside the
standard's MES scope but is allowed as nested equipment.

| Our tree (HierarchicalStructures, IDTA 02011) | ISA-95 level | Note |
|---|---|---|
| Company (entry node of the top process file) | Enterprise | |
| (missing today) plant / factory | **Site** | Add an optional `site` attribute or node type; Korean SMEs often have 1 site, but a holding with 2 plants breaks without it |
| Line (`line: true` node) | Area **or** Work center (production line) | Ambiguous — let the user pick per node; default `Area` |
| Process (group node) | Work center | |
| Equipment (node with `globalAssetId`) | Work unit | |
| Parts (BoM below equipment) | not ISA-95 equipment — **do not export as equipment**; optionally as PhysicalAsset children or omit | |

Concrete change: store an explicit `equipmentLevel` on each hierarchy node (ISA-95 enum) instead of inferring from depth. Inferring
from depth is exactly the kind of guess that breaks at the second customer.

### 3.2 Neutral JSON (MUST)

`GET /hierarchy/export?format=json&root=<packageId>` — flat list (MES importers prefer flat + parent id over nested):

```json
{
  "schema": "kr.vexplor.aas.hierarchy.v1",
  "generatedAt": "2026-10-14T02:00:00Z",
  "nodes": [
    { "id": "WACE", "parentId": null, "equipmentLevel": "Enterprise", "name": "WACE", "globalAssetId": null },
    { "id": "WACE/Changwon", "parentId": "WACE", "equipmentLevel": "Site", "name": "Changwon" },
    { "id": "WACE/Changwon/Line-A", "parentId": "WACE/Changwon", "equipmentLevel": "Area", "name": "Line-A" },
    { "id": "WACE/Changwon/Line-A/Pressing", "parentId": "WACE/Changwon/Line-A", "equipmentLevel": "WorkCenter", "name": "Pressing" },
    { "id": "WACE/Changwon/Line-A/Pressing/Press-03", "parentId": "WACE/Changwon/Line-A/Pressing",
      "equipmentLevel": "WorkUnit", "name": "Press-03", "quantity": 1,
      "globalAssetId": "https://example.com/ids/asset/press-03",
      "aasId": "https://example.com/ids/aas/press-03",
      "serialNumber": "SN-2024-00317",
      "specificAssetIds": { "MesEquipmentCode": "PRS-03" },
      "manufacturer": "...", "model": "...",
      "packageId": "pkg_8f2c..." }
  ]
}
```
Same content as CSV (`id,parentId,equipmentLevel,name,globalAssetId,serialNumber,mesCode`) — this is what a Korean MES admin will
actually paste into their equipment master screen.

Quantity (`bulkCount`, "×quantity" in §7-5): an MES equipment master needs **one row per physical unit**. If a node says ×3 with
one `globalAssetId`, export a warning, not three invented ids. Instances must be split ("per unit") before export; lint it.

### 3.3 B2MML (SHOULD, after JSON)

Offer B2MML **Equipment** (ISA-95 Part 2 role-based equipment) because that is what Opcenter / Critical Manufacturing style MES import.
PhysicalAsset is optional; only offer it when serial numbers exist (PhysicalAsset = the concrete serialized unit, Equipment = the role).

Minimal elements for `SyncEquipment` / `ShowEquipment` [B2MML verb names per MESA BOD convention — verify against the XSD version you target]:

```xml
<Equipment>
  <ID>WACE/Changwon/Line-A/Pressing/Press-03</ID>
  <Description>Press-03</Description>
  <EquipmentLevel>WorkUnit</EquipmentLevel>
  <EquipmentProperty>
    <ID>globalAssetId</ID>
    <Value><ValueString>https://example.com/ids/asset/press-03</ValueString></Value>
  </EquipmentProperty>
  <EquipmentProperty>
    <ID>SerialNumber</ID>
    <Value><ValueString>SN-2024-00317</ValueString></Value>
  </EquipmentProperty>
  <!-- nested child Equipment elements, or flat with parent reference -->
</Equipment>
```
- Namespace / version (V0600 vs V0700 vs V0800): **[unverified]** — pick one, ship its XSD in the test fixtures (check MESA's
  license terms for redistributing the XSDs **[unverified]**), and validate output in CI. Do not ship B2MML that has never been
  XSD-validated; MES import tools reject silently or partially.
- Generate with string templates + XML escaping (no dependency). Element order matters in B2MML (xs:sequence) — test it.
- EquipmentLevel enum value spelling (e.g. `WorkCenter` vs `Work Center`, `ProcessCell`) **[unverified]** per B2MML version; take
  it from the XSD, not from memory.

---

## 4. OEE inputs — what is honest

ISO 22400-2 defines OEE index = Availability × Effectiveness × Quality ratio, with Availability = APT / PBT,
Effectiveness = (PTU × PQ) / APT, Quality ratio = GQ / PQ (APT actual production time, PBT planned busy time,
PTU planned run time per unit, PQ produced quantity, GQ good quantity). I am confident in these definitions; exact
section/clause numbers I would not quote.

| Input | Can the tool provide it? | How / caveat |
|---|---|---|
| Time in run / stop / alarm / off / no-data per equipment per shift | **Yes** — already computed for the daily bar | Move to server; expose `GET /equipment/{globalAssetId}/state-segments?from&to` and per-shift totals. Resolution = collection interval. Report `noData` and `unknown` explicitly, never fold them into "stop" |
| APT (actual production time) | **Approximation**: time in `run` | Label as "run time per equipment signal", not APT, unless the customer confirms the run signal means producing |
| PBT (planned busy time) | **No** | Comes from MES shift calendar / planned downtime. The fixed 08:00 day start in `DailyStates.tsx` must become a configurable shift calendar (or accepted from MES) |
| Planned downtime vs unplanned (ADOT vs PDOT) | **No** | MES knows breaks, changeovers, maintenance plans. The tool can only say "stopped" |
| PQ (produced quantity) | **Yes, if** a counter tag exists | Sum of counter deltas; resets flagged, not guessed |
| GQ / scrap / rework | **Only if** the machine has separate good/NG counters or an OK/NG judgment tag | Otherwise **No** — quality usually comes from MES inspection |
| PTU (planned run time per unit, cycle time standard) | **No** (master data) | Could be read from a TechnicalData property if the model has one; still label it "nominal from model" |
| Reason codes for stops | **No** | MES / operator input. Offer `rawValue` of alarm code only |

Recommendation: **do not ship an "OEE" number in the tool.** Ship `GET /equipment/{id}/oee-inputs?shift=...` returning
`{ runMs, stopMs, alarmMs, offMs, unknownMs, noDataMs, producedDelta, goodDelta|null, rejectDelta|null, resolutionMs, coverage }`
where `coverage = 1 - noDataMs / windowMs`. MES computes OEE with its own PBT. An OEE figure computed without planned time is the
fastest way to lose a plant manager's trust.

---

## 5. Delivery semantics and security

### 5.1 Architecture (fits the existing store port)

1. **Detector** (server, after each collection cycle in `supervisor.ts`/`runner.onCycle`): compares new samples with the
   **persisted last-known state** per (globalAssetId, key) and produces events. The last-known state must be persisted, otherwise a
   restart re-emits every state as a "change".
2. **Event log** = new store port methods, implemented in memory / folder / PostgreSQL and covered by the **same conformance suite**:
   - `appendEvents(events[]) → assigns monotonic sequence` (single writer; in Postgres `bigserial` or a sequence)
   - `listEvents({ after, limit, types?, globalAssetId? })`
   - `deliveryState` per subscription: `{ subscriptionId, lastAckedSeq, attempts, nextAttemptAt, status }`
   - `deadLetters` per subscription
   - retention (`EVENT_RETENTION_DAYS`), same receive-time basis as values
   Detector writes events **in the same transaction** as nothing else needs to be atomic with it (values are append-only), so a
   simple append is enough; the important part is that dispatch reads only from the log (transactional outbox pattern).
3. **Feed** `GET /events?after=<seq>&limit=500&types=...` → `{ items, nextAfter }`. MES stores `nextAfter`. Read with API key.
4. **Dispatcher** for webhook subscriptions (`POST/GET/DELETE /subscriptions`, admin only).

### 5.2 Semantics

| Property | Decision |
|---|---|
| Guarantee | **At-least-once.** Say so in docs. Exactly-once is not offered by anyone honest over HTTP |
| Idempotency key | CloudEvents `id`, **deterministic**: `sha256(globalAssetId | type | key | occurredAt | newValue)` truncated, so a re-detected duplicate after crash gets the same id. Also `sequence` (server-monotonic) |
| Ordering | Guaranteed **per `globalAssetId`** (partition key). Dispatcher delivers one in-flight request per (subscription, asset); different assets may interleave. Document it |
| Retries | Exponential backoff with jitter: 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, then hourly up to 24 h (configurable). Retry on network error, 408, 429 (honor `Retry-After`), 5xx. **No retry** on other 4xx → straight to dead letter |
| Success | Any 2xx within timeout (10 s default) |
| Dead letter | After max age/attempts: move to DLQ, mark subscription `degraded`, show in UI, `POST /subscriptions/{id}/replay?from=<seq>` |
| Head-of-line | Per-asset ordering means a poisoned event blocks that asset only; DLQ releases it |
| Batching | Optional `batch=true` → `application/cloudevents-batch+json` array, max 100 events or 256 KB |
| Backpressure | Cap log growth; if a subscription is > N events behind, mark `lagging` (visible), never drop silently |
| Clock | Payload carries both `observedAt` (device) and `receivedAt` (tool) — the code already learned why (`types.ts` receivedAt note) |

### 5.3 Security

- **Webhook signing (MUST)**: HMAC-SHA256 with node:crypto. Follow the *Standard Webhooks* convention — headers `webhook-id`,
  `webhook-timestamp`, `webhook-signature: v1,<base64>` over `"{id}.{timestamp}.{body}"` [header names as I recall the spec —
  verify before freezing **[unverified]**]. Per-subscription secret, shown once, rotatable with two active secrets during rotation.
  Receivers reject timestamps older than 5 min (replay protection). Ship a 20-line verification snippet (TS, Java, C#) in docs —
  Korean MES teams are mostly Java/.NET.
- **TLS**: webhook targets must be `https://` unless an admin explicitly allows `http://` for an internal host (flag per
  subscription). Server-side TLS is already handled by the Caddy reverse proxy example.
- **SSRF**: subscription URLs are admin-only; block link-local/metadata addresses (169.254.0.0/16) by default.
- **Feed / REST auth**: existing Bearer API keys; add a **read-only "integration" key scope** (events + values + hierarchy, no
  model writes). The MES should never hold a key that can delete packages.
- **OPC UA server auth (MUST before anyone points an MES at it)**: node-opcua supports this without new deps:
  - security policies `Basic256Sha256` (+ `Aes128_Sha256_RsaOaep`, `Aes256_Sha256_RsaPss`), modes `Sign` / `SignAndEncrypt`;
    disable `None` by default when `OPCUA_SERVER=on` (keep an explicit `OPCUA_ALLOW_INSECURE=on` for lab use)
  - user tokens: `UserName` mapped to the existing account store (viewer role is enough, server is read-only) or API key as password;
    `allowAnonymous: false` by default
  - certificate trust list (PKI folder) with a UI or CLI to accept client certs; the default node-opcua behavior of auto-trusting or
    auto-rejecting must be made explicit
  - publish `ServerStatus`/build info so MES can see version
- Mask credentials in every event and log (`mqtt://user:pass@` already appears in AID addresses).

---

## 6. Other concrete gaps found in the code

1. **State rules live in the browser** (`localStorage` key `aas.stateRules`). Move to a server-side, per-package (or per-equipment
   class) rule set with an id/version (`ruleSetId` in events). Share `states.ts` logic as a package used by both web and api so the
   bar and the events can never disagree. MUST — prerequisite for §2.
2. **Shift start hard-coded at 08:00.** Make a server-side shift calendar (`shifts: [{name, start, end}]`, timezone explicit,
   `Asia/Seoul` default). MUST for any per-shift output.
3. **Values are keyed by (packageId, interfaceName, propertyName)**, and REST overlay requires AID property name == idShort.
   For MES, every value/event must resolve to `submodelId + idShortPath`. Store the resolved path at collection time or resolve it in
   the detector; flag unresolved tags in the event rather than dropping them.
4. **MES field ↔ AAS path mapping**: provide a per-server mapping table
   `{ mesField: "EQ_STATUS", semanticId?: "...", submodelIdShort: "OperationalData", idShortPath: "MachineState", transform?: "stateRules:v4" }`
   with CSV import/export. Do not add ISO 22400 semanticIds until IRIs are verified — the current decision is right; the mapping
   table makes semanticIds optional anyway.
5. **Polling resolution.** Event timestamps are bounded by `COLLECT_INTERVAL`. For OPC UA sources, add a *subscription-based* reader
   option (monitored items on state/alarm/counter tags only) so state changes are timestamped by the device, not by the poll. MQTT is
   already push from the broker — record message arrival time. SHOULD.
6. **Hierarchy has no Site level and no explicit equipment level** (§3.1). SHOULD.
7. **`bulkCount` instances** cannot be MES equipment rows (§3.2). Lint before export.

---

## 7. Test plan — what proves an MES can rely on it

All tests use the existing injectable timers/clock and the built-in PLC simulator (alarm 5 s every 40 s, ProductionCount increasing,
BrokenSensor). No real time waits.

**A. Store conformance (memory / folder / PostgreSQL, one suite)**
- appendEvents assigns strictly increasing sequence; concurrent appends never duplicate or skip
- listEvents(after) returns exactly the tail; pagination stable while appends happen
- delivery state and DLQ survive restart (folder + Postgres); retention removes by receive time only

**B. Detector correctness (golden scenarios)**
- Simulator 10 min, interval 1 s: exactly 15 `alarm.raised` and 15 `alarm.cleared`, each pair shares `alarmInstanceId`,
  durations 5 s ± interval
- State sequence run→alarm→run produces exactly two `state.changed`; constant values produce zero events
- Restart mid-run: **no** spurious `state.changed` on startup (last-known state persisted); same deterministic `id` if a cycle is
  re-processed
- Counter: monotonic increase → deltas sum to `last - first`; injected reset → one `reset: true`, `delta: null`; no event when
  delta = 0
- Connection: stop simulator → one `connection.lost` after debounce; restart → one `restored`; BrokenSensor alone never triggers
  `lost`
- Unknown raw value (not in rules) → state `unknown`, never mapped to stop
- Threshold with hysteresis: noisy signal around the limit yields 1 crossing, not N

**C. Delivery (fault injection with a local node:http receiver)**
- Receiver returns 500 ×3 then 200 → delivered once more after success, retries follow schedule, order per asset preserved
- Receiver returns 400 → DLQ immediately, other assets keep flowing
- Receiver 429 with Retry-After → honored
- Kill the server between send and ack → event is re-sent after restart with the **same** `id` (at-least-once proven)
- Receiver hangs → timeout, retry; no unbounded memory growth with 10k pending events
- Replay from sequence N reproduces byte-identical bodies (signature recomputed with current timestamp)

**D. Contract**
- Every emitted event validates against its published JSON Schema (`/events/schemas/...`) — run in CI over all scenario outputs
- Signature test vectors (fixed secret, id, timestamp, body → expected signature) published in docs and asserted in tests; verify
  with an independent implementation (e.g. a small Java/.NET snippet in a doc test, or at least a second TS implementation)
- Hierarchy JSON/CSV export: round-trip the demo process file; every WorkUnit has `globalAssetId`; ×quantity nodes raise a warning
- B2MML: XSD validation of output against the chosen B2MML version in CI (fails the build on invalid XML)

**E. OPC UA server**
- Anonymous + `None` rejected by default; UserName with viewer account accepted; wrong password rejected; untrusted client cert
  rejected until trusted
- Subscription with UaExpert-like client (`scripts/opcua-browse.mjs --watch` extended) receives value changes within one interval
- Writes rejected (`BadNotWritable` or equivalent) on every node

**F. Soak / acceptance**
- 24 h run, 50 simulated machines, interval 5 s, two webhook subscribers (one flaky): zero lost events (compare log sequence vs
  receiver), stable memory, event lag < 2 intervals at p99
- A written **integration acceptance checklist** the SI team signs with the customer's MES team: join key agreed
  (globalAssetId vs MES code), state rule set version agreed, shift calendar agreed, delivery mode chosen, secrets exchanged

---

## 8. Prioritised backlog (implementable in this codebase, no or near-zero new dependencies)

**MUST**
1. Server-side state rules + shared state module (web and api use the same code) + shift calendar
2. Detector with persisted last-known state; events: state changed, alarm raised/cleared, counter advanced, connection lost/restored
3. Event log in the store port + conformance tests (memory/folder/Postgres)
4. `GET /events?after=` cursor feed + JSON Schemas + read-only integration API key scope
5. Asset join block: globalAssetId, serialNumber (Nameplate), editable `specificAssetIds` incl. MES equipment code, hierarchy path
6. Webhook subscriptions: outbox dispatcher, HMAC signing, retries, DLQ, replay
7. OPC UA server security (policies, user auth, cert trust), insecure only by explicit flag
8. Hierarchy export JSON + CSV with explicit ISA-95 `equipmentLevel`

**SHOULD**
9. `oee-inputs` and `state-segments` endpoints (no OEE number)
10. MQTT JSON publish of the same events (`vexplor/{site}/{area}/{workCenter}/{workUnit}/events/{type}`, QoS 1, not retained for
    events, retained for current state)
11. Shift CSV drop (file/batch pattern for legacy MES)
12. B2MML Equipment export, XSD-validated
13. Threshold rules, freshness events, model/hierarchy change events
14. OPC UA subscription-based reading for state/alarm/counter tags (device-timestamped transitions)
15. MES field ↔ AAS path mapping table with CSV import/export

**LATER**
16. Sparkplug B (protobuf, birth/death certificates)
17. OPC UA Alarms & Conditions (Part 9) and an `Events/` area in the served address space; consider OPC UA for Machinery
    (OPC 40001-1) MachineryItemState mapping of our states **[unverified which revision defines it]**
18. IDTA Time Series Data submodel (IDTA 02008) export of collected values as a linked/external segment
19. AAS-native eventing if/when IDTA standardizes Part 2 event messages **[unverified status]**

Do not build: writing into customer MES databases; MES → machine commands; an OEE figure without MES planned time.
