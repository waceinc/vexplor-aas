# VEXPLOR AAS Studio — what a CMMS/EAM needs from it

Independent opinion, maintenance-systems integration (Maximo / SAP PM / SaaS CMMS such as Fiix or UpKeep, Korean plant maintenance practice).
Read: README.md, docs/usage.md §8, sample `RollFormingMachine_sample.aasx` (aasx/data.json), `apps/api/src/routes/*.ts` (route list), `packages/collector/src/{types,runner}.ts`, `packages/store/src/types.ts`.
No repository file was edited.

---

## 0. Findings that shape everything else

These come from the code and the sample, not from general advice.

| # | Finding | Why a CMMS integrator cares |
|---|---|---|
| F1 | The sample shell is `assetKind: "Type"`, but its DigitalNameplate carries `SerialNumber = EXM-RFL-2026-00127` and `DateOfManufacture`. | A CMMS asset record is a **physical instance** (one per serial). If the tool syncs Type shells as assets, the CMMS gets one "asset" standing in for many machines and meter readings from different machines land on it. Instance identity must be explicit before any sync. |
| F2 | `MaintenanceInstructionsForSpecificInterval_0` has **no interval value or unit** — only ID, name, source, safety text, technicians, steps (durations), tools, consumables. | A PM plan without a trigger (every N hours / N days / N cycles) cannot be scheduled. Exporting it as if it were a schedule would be inventing data. |
| F3 | Collection is **polling** (`runner.ts`: interval measured from the end of a cycle, `COLLECT_INTERVAL` e.g. 30 s; MQTT returns "last value received"). Values are stored as samples, not as change events. | Short alarms are lost. The bundled simulator raises an alarm for 5 s every 40 s; at a 30 s poll this is sampled at most sometimes. Any "alarm raised/cleared" output derived from samples must say what resolution it has. |
| F4 | Collected values never flow back into the model (Option A) and are kept with `quality`, `observedAt` (device time) and `receivedAt` (tool time). | Good basis: evidence is preserved, bad-quality values are kept and flagged. Derived maintenance outputs should follow the same discipline (derived, never written into the AASX). |
| F5 | Only pull surfaces exist: Part 2 REST, `/packages/:id/values`, `/packages/:id/live`, `/collect-status`, OPC UA server (unauthenticated, read-only). Auth = session or API key with `full` / `read-only` levels. | A CMMS needs **push** for events (nobody polls for alarms every 10 s from Maximo) and a **read-only, per-integration credential** for pulls. |
| F6 | `CumulativeRunHours = 5200.0` in OperationalData is a **file value**, while live values come only via `?live=true` overlay. | The CMMS must never read the file value as a meter reading. The meter must come from the time series with a timestamp and source tag, or not at all. |

---

## 1. Equipment register sync

### MUST

1. **Stable external key per physical asset.** Use the shell's `assetInformation.globalAssetId` only when the shell is `Instance`; otherwise refuse to export it as an asset. Expose also: AAS `id`, package id, and `SerialNumber`. The CMMS stores the globalAssetId in an external-reference field and never matches on name.
   - Rule: one CMMS asset = one Instance shell = one globalAssetId. Never re-key; if the globalAssetId changes, emit a "replaced-by" record, not an update.
2. **Register record fields** (read from DigitalNameplate by semanticId, not by idShort):
   - `assetId` (globalAssetId), `aasId`, `serialNumber`, `manufacturerName` (all languages), `productDesignation`, `productType` (`ManufacturerProductType`), `yearOfConstruction`, `dateOfManufacture`, `typeAssetId` (the Type shell it was derived from, via the existing derivation route), `revision` (package revision), `updatedAt`.
   - Each field carries its source path (`submodelId` + idShortPath) so the CMMS side can show where the value came from.
   - Missing fields are `null`, not empty strings and not defaults.
3. **Hierarchy/location** from what the tool already has (HierarchicalStructures / §7 process files with "×quantity vs per unit"): export `parentAssetId` and `children[]` only for instance links. Location (plant / line / bay) is **not** in the AAS sample — take it as an optional, user-entered mapping field, or leave it to the CMMS. Do not derive a location from a process-file name.
4. **Endpoint:** `GET /cmms/assets?updatedSince=<ISO>&cursor=` → paged JSON (reuse the Part 2 cursor style). Deletions appear as tombstones (`status: "removed"`) rather than vanishing, so the CMMS can decommission, not delete.

### SHOULD

- Sub-assemblies from BoM (`HasPart_RollStandUnit`) exported as child components so rolls/stands can carry their own PM.
- A `criticality` field left `null` unless entered by a person (the CMMS normally owns it).
- CSV export of the same register (Korean plants often onboard via Excel import into the CMMS).

### LATER

- Asset classification mapping (e.g. to an ISO 14224 equipment class [unverified that the sample's types map cleanly]) as a user-maintained table, never automatic.

---

## 2. Meter readings (run hours, cycle counts) for usage-based PM

### MUST — derive honestly

Two kinds of meter, handled differently:

| Kind | Source | Derivation |
|---|---|---|
| **Device counter** (e.g. `CumulativeRunHours`, `ProductionCount`, `CumulativeEnergy` read from the PLC) | collected samples of that tag | report the **raw reading** plus a **delta** since the last delivered reading |
| **Computed run time** (no counter on the device) | MachineState samples + status rules (the daily status bar logic) | integrate time in "Running" only between consecutive samples that are both within the freshness window; gaps contribute **zero** and are reported as `unknownSeconds` |

Rules for counters:

1. **Reset / rollover detection:** if `new < previous`:
   - if `previous` is near a known register maximum (16-bit 65535, 32-bit 4294967295, or a configured max) → treat as rollover, delta = `(max - previous) + new + 1`, flag `rollover: true`;
   - otherwise → treat as **reset**, delta = `new` (counted from zero) is *not* assumed; emit delta `null`, flag `reset: true`, and start a new baseline. The CMMS should get the reset as information, not a guessed number.
2. **Implausible jump guard:** delta greater than `elapsedSeconds × maxRate` (configurable; for run hours maxRate = 1 h/h) → delta `null`, flag `implausible: true`. Never clamp.
3. **Bad quality** samples (`quality` not Good) are excluded from deltas; reported count of excluded samples.
4. **Gaps:** if no good sample for longer than the freshness window, the reading carries `gap: true` and the period's delta covers only the spans with data.
5. Use `receivedAt` for ordering and gap detection (consistent with §8 freshness), keep `observedAt` as evidence.
6. Readings are **cumulative-plus-delta**, idempotent by `readingId = hash(assetId, meterId, observedAt of the reading sample)`.

Payload (one reading):

```json
{
  "readingId": "sha256:…",
  "assetId": "https://…/asset/RFL-00127",
  "meterId": "CumulativeRunHours",
  "meterKind": "deviceCounter",
  "unit": "h",
  "reading": 5231.4,
  "delta": 3.2,
  "periodStart": "2026-10-14T08:00:00+09:00",
  "periodEnd": "2026-10-14T11:12:00+09:00",
  "observedAt": "2026-10-14T11:11:58+09:00",
  "receivedAt": "2026-10-14T11:12:00+09:00",
  "flags": { "rollover": false, "reset": false, "gap": false, "implausible": false, "simulated": false },
  "excludedBadSamples": 0,
  "source": { "interface": "PLC1", "property": "CumulativeRunHours", "address": "ns=1;s=Machine.RunHours" },
  "evidence": "/packages/{pkg}/values?property=CumulativeRunHours&from=…&to=…&basis=received"
}
```

- `unit` comes from the AID property / ConceptDescription; if absent, `null` — never assume "h".
- `simulated: true` whenever the AID is the "Virtual PLC (simulation)" link (§8-3 already names it). A CMMS must be able to reject simulated meters.

**Cadence:** CMMS meters do not need sub-minute data. Default: one reading per meter per shift or per day (configurable 15 min … 24 h), plus on-demand pull `GET /cmms/meters?assetId=&since=`. Daily roll-up aligned with the existing 08:00 day boundary, but stated explicitly in the payload (`periodStart/periodEnd` with offset) — do not rely on the receiver knowing "the day starts at 08:00".

### SHOULD

- Computed run hours from MachineState, with `runningSeconds`, `stoppedSeconds`, `alarmSeconds`, `offSeconds`, `unknownSeconds` per period — the same numbers as the daily status bar, so the screen and the CMMS agree.
- Cycle counters derived from rising edges of a boolean only if sampled faster than the cycle time; otherwise refuse and say why.

### LATER

- Condition-based meters (e.g. `RollGapDeviation` as a gauge reading) once thresholds exist (§3).

---

## 3. Condition events → work requests

### MUST — event types

| Event | Trigger | Clears on |
|---|---|---|
| `alarm.raised` / `alarm.cleared` | status mapped to Alarm (existing status rules) or boolean alarm tag true | value leaves Alarm for ≥ clear-delay |
| `threshold.crossed` / `threshold.returned` | user-defined limit on a numeric tag (high/low) | value back inside limit minus hysteresis band for ≥ clear-delay |
| `connection.lost` / `connection.restored` | collect-status goes to "Connection failed", or all tags of the asset stale beyond the freshness window | next successful read |
| `quality.bad` (should) | one tag Bad for ≥ N cycles | Good again |

`connection.lost` must be clearly **not** an equipment fault — it is a data-path event. Default routing: to IT/OT, not to the maintenance backlog.

### MUST — debounce / hysteresis

- **Raise delay** (default: value must hold for 2 consecutive samples or T seconds) and **clear delay** (same). Configurable per rule.
- **Hysteresis band** for numeric thresholds (e.g. raise at > 80 °C, clear at < 75 °C).
- **One open event per (assetId, ruleId)**. Repeats while open increment `occurrences` instead of opening new requests — this is what stops a flapping sensor from creating 200 work orders.
- **Resolution disclosure:** each event carries `samplingIntervalSeconds`. Alarms shorter than the poll interval are invisible (F3). Document this, and recommend either OPC UA subscription in the collector or a latched alarm counter on the PLC side for alarms that matter.

### MUST — payload

```json
{
  "eventId": "uuid-v7",
  "dedupKey": "<assetId>|<ruleId>|<raisedAt>",
  "type": "alarm.raised",
  "assetId": "https://…/asset/RFL-00127",
  "ruleId": "alarm-tag:AlarmActive",
  "raisedAt": "2026-10-14T10:02:31+09:00",
  "detectedAt": "2026-10-14T10:03:01+09:00",
  "value": true,
  "previousValue": false,
  "severity": "high",
  "severitySource": "rule",
  "source": { "interface": "PLC1", "property": "AlarmActive", "address": "ns=1;s=Machine.Alarm", "quality": "Good" },
  "samplingIntervalSeconds": 30,
  "simulated": false,
  "evidence": {
    "values": "/packages/{pkg}/values?property=AlarmActive&from=…&to=…",
    "aas": "/shells/{aasIdB64}/submodels/{smIdB64}/submodel-elements/MaintenanceMonitoring.MaintenanceState.AlarmActive"
  },
  "suggestedMaintenanceIds": []
}
```

- `severity` comes from the rule a person configured, never inferred. If no severity is set, send `null`; the CMMS decides priority.
- `raisedAt` = time of the first qualifying sample (device time when trustworthy), `detectedAt` = when the debounce confirmed it. Both, so nobody argues later about response time.
- `suggestedMaintenanceIds` may link to a `MaintenanceID` from MaintenanceInstructions **only** when a person mapped the rule to it. Never a guessed link.
- The tool emits a **work request / notification**, not a work order. Approval, planning, failure coding stay in the CMMS.

### SHOULD

- Alarm code/text pass-through when the PLC exposes an alarm number or message tag (raw, unmapped).
- Suppression while `MaintenanceMode = true` (the sample already has it) — events during maintenance carry `suppressed: true` instead of being dropped.

---

## 4. Maintenance plan export (MaintenanceInstructions)

### MUST

Export each `MaintenanceInstructionsForSpecificInterval_*` as a **job plan / task list template**, not as a schedule:

```json
{
  "maintenanceId": "MI-RollForming-01",
  "name": { "ko": "…", "en": "…" },
  "source": { "ko": "…" },
  "safety": { "ko": "…" },
  "interval": null,
  "intervalStatus": "missing",
  "technicians": { "count": 1, "qualification": { "ko": "…" } },
  "steps": [
    { "seq": 1, "stepId": "RollStep01", "name": {…}, "instruction": {…},
      "estimatedDuration": { "value": 15, "unit": "min" },
      "tools": ["TOOL-01"], "consumables": [], "documents": [],
      "signatureRequired": false, "isLast": false }
  ],
  "tools": [{ "id": "TOOL-01", "name": {…} }],
  "consumables": [{ "id": "CONS-01", "name": {…} }],
  "estimatedTotalDuration": { "value": 80, "unit": "min", "basis": "sum of step estimates" },
  "sourceRef": { "submodelId": "…", "idShortPath": "MaintenanceInstructionsForSpecificInterval_0" },
  "revision": 12
}
```

- `interval` is filled only when the model contains an explicit interval value + unit + basis (calendar / run hours / cycles). In the current sample it does not (F2) → `null` with `intervalStatus: "missing"`. The linter should flag this as a finding for any file meant for CMMS hand-over.
- Steps keep their **model order** and `ReferenceElement` targets resolved to tool / consumable IDs. Unresolvable references are reported, not dropped.
- `DocumentationSignatureMandatory = true` maps to `signatureRequired`; the CMMS must enforce sign-off.
- Multi-language properties exported with all languages; the CMMS picks.
- Plan versioning: include the package `revision` and a content hash; a CMMS job plan revision is created only when the hash changes.

### SHOULD

- CSV / Excel flat form (one row per step) — this is how most Korean plants load task lists.
- `GET /cmms/plans?assetId=` returning plans that apply to an Instance via its Type.

---

## 5. Documents and attachments

### MUST

- Export HandoverDocumentation entries as document links: `documentId`, `classId` + `classificationSystem` (VDI 2770 in the sample), `title`, `version`, `language`, `status`, `statusSetDate`, `organization`, and a **download URL** for each `DigitalFile`.
- The sample's `file:///EXM_RFL_InstallManual_V1.0.pdf` and `file:///RollReplace_Record_V1.pdf` are package-internal paths. The tool must serve them as `GET /packages/{id}/files/{part}` (or the Part 2 attachment endpoint) with `contentType`, size and sha256, behind the same read-only credential. A CMMS cannot open `file:///`.
- Step-level documents (`RelatedDocumentOrFileMaintenanceStep`) linked to the step, not only to the asset.
- Missing file in the package → `available: false`, not a broken URL.

### SHOULD

- Links rather than copies by default (single source, revision stays in the AASX); optional copy mode with hash for CMMS systems that must store attachments locally.

---

## 6. Delivery semantics and security

### MUST

1. **Outbox pattern.** Events and meter readings are first written to an outbox table in the existing store (memory / Postgres), then delivered. Restarting the server must not lose or regenerate them.
2. **At-least-once delivery + idempotency key.** Every message has `eventId`/`readingId` and a `dedupKey`; header `Idempotency-Key`. Receivers must treat duplicates as no-ops — document this as a receiver requirement.
3. **Webhook push** (`POST` JSON) with retry: exponential backoff (e.g. 10 s → 1 h cap), max age (e.g. 7 days) then dead-letter visible on screen. Per-target ordering by `(assetId, sequence)` with a monotonically increasing `sequence` so receivers can detect gaps.
4. **Pull fallback:** `GET /cmms/events?after=<sequence>` — many CMMS integrations (Maximo MIF, SAP PI/CPI) prefer to poll a cursor. Same payloads.
5. **Signing:** HMAC-SHA256 over the raw body with a per-target secret, header with timestamp; receivers reject old timestamps (replay). Node `crypto` is enough — no new dependency.
6. **Credentials:** dedicated read-only API key per integration (the `read-only` level already exists), plus asset scope where workspaces are split (`owner`). The OPC UA server has no auth (§8-6) — never recommend it as the CMMS path.
7. **HTTPS only** for webhook targets outside localhost; refuse `http://` unless explicitly allowed per target.
8. **Audit:** delivery log (sent, status code, attempt, latency) kept with the same retention as values.

### SHOULD

- MQTT publish of events as an alternative transport (the tool already speaks MQTT 3.1.1 wire format; QoS 1 would be needed — current test broker is QoS 0 only).

### MUST NOT invent

- **Failure codes / problem-cause-remedy** (ISO 14224-style failure modes) — the tool does not know the failure mode; an alarm is a symptom.
- **Costs, labour rates, spare-part prices, stock levels.**
- **Priority / criticality** without a person's rule.
- **Intervals** missing from MaintenanceInstructions (F2).
- **Meter deltas across resets or gaps.**
- **Instance identity** from a Type shell (F1).
- **Location** not entered by a person.
- Any simulated value without `simulated: true`.

---

## 7. Test plan — proving a CMMS can rely on it

All runnable with the existing virtual PLC / test MQTT broker and vitest; no hardware.

| ID | Test | Pass condition |
|---|---|---|
| T1 | Counter rollover: drive a 16-bit counter 65530 → 4 | delta = 10, `rollover: true` |
| T2 | Counter reset: 5231.4 → 0.2 (not near max) | delta `null`, `reset: true`, new baseline; next reading delta correct |
| T3 | Implausible jump: run hours +50 within 10 min | delta `null`, `implausible: true` |
| T4 | Gap: stop simulator 20 min with 30 s polling | reading `gap: true`; computed run time adds 0 for the gap; `unknownSeconds` ≈ 1200 |
| T5 | Bad quality: `BrokenSensor` / Bad status samples | excluded from deltas; counted |
| T6 | Duplicate delivery: receiver returns 500 after accepting | message re-sent with same idempotency key; receiver-side count = 1 |
| T7 | Server restart mid-retry | outbox survives; no lost, no regenerated IDs; sequence continues |
| T8 | Flapping alarm: toggle every 2 s for 2 min, raise delay 10 s | ≤ 1 open event, `occurrences` counted, no request storm |
| T9 | Hysteresis: temperature oscillating 79–81 around 80 limit, band 5 | exactly 1 raised, 0 cleared until < 75 |
| T10 | Short alarm below poll interval (simulator 5 s alarm, 30 s poll) | documented miss rate measured and shown; with subscription/latched counter mode → 100 % caught |
| T11 | Connection lost vs equipment alarm | `connection.lost` raised, no `alarm.raised`; restored clears it |
| T12 | Maintenance mode on | events carry `suppressed: true` |
| T13 | Type shell export to asset register | refused with reason; Instance export succeeds |
| T14 | Plan export from sample | `interval: null`, `intervalStatus: "missing"`, step order 1-2-3, tools/consumables resolved, signature flag on step 3 |
| T15 | Document links | every DigitalFile resolves to a downloadable URL with matching sha256; missing file → `available: false` |
| T16 | Webhook signature | tampered body / old timestamp rejected by the reference receiver |
| T17 | Simulated source | every reading/event from the virtual PLC link has `simulated: true` |
| T18 | Timezone / day boundary | daily roll-up across 08:00 boundary and DST-free KST offset matches the daily status bar totals |
| T19 | Replay from cursor | `GET /cmms/events?after=n` returns the same messages as pushed, in sequence |

Also ship a small **reference receiver** (Node script, ~150 lines) that verifies signatures, deduplicates, and logs — it doubles as the acceptance tool for each CMMS integration.

---

## 8. Priority summary

| Priority | Item |
|---|---|
| MUST | Instance-only asset register with globalAssetId key (F1) · meter readings with rollover/reset/gap/quality flags · alarm/threshold/connection events with debounce + hysteresis + dedup · outbox + at-least-once + idempotency + HMAC + read-only key · plan export without invented intervals · document download URLs · `simulated` flag everywhere |
| SHOULD | Computed run time from MachineState · OPC UA subscription (or latched counter guidance) for short alarms · maintenance-mode suppression · CSV exports for register and task lists · BoM children as components · linter rule "interval missing" for hand-over files |
| LATER | Asset class mapping (user-maintained) · MQTT QoS 1 event transport · condition-based gauge meters |

Implementation fits the current stack: Node `crypto` (HMAC, sha256), the existing store for outbox/delivery tables, existing route/cursor conventions, existing status rules and freshness window logic. No new runtime dependency is required.

### Standards referenced

- IDTA Part 2 (AAS API) and IDTA-02017 AID — as used by the product.
- VDI 2770 classification — appears in the sample's HandoverDocumentation.
- ISO 14224 — cited only as the source of failure-mode taxonomies that the tool must not fill in; the mapping of the sample's equipment to its classes is [unverified].
- IEC 60300 (dependability management) — general context only; no specific clause relied on [unverified].
- No CMMS vendor API specifics are asserted here; per-vendor adapters (Maximo OSLC/REST, SAP PM notification APIs) should be verified against the customer's version [unverified].
