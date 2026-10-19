**English** · [한국어](연동.md)

# VEXPLOR AAS Studio — Connecting MES, ERP and CMMS

This guide is for the **integration engineer** who connects VEXPLOR AAS Studio to a plant's MES, ERP or CMMS, and for
the administrator who sets it up. People who only author AASX files need [usage.md](usage.md) instead.

The API reference is [openapi/integration.yaml](openapi/integration.yaml) (OpenAPI 3.0.3). The design behind every
decision here is [design/integration-v1.md](design/integration-v1.md).

| Chapter | Contents |
|---|---|
| [1](#1-what-integrates-how) | What integrates how — and what this tool never does |
| [2](#2-turning-it-on) | Turning it on — settings, the Integrations window |
| [3](#3-identity-and-join-keys) | Identity and join keys — globalAssetId, serial numbers, external references, discovery |
| [4](#4-events) | Events — envelope, catalogue, ordering and idempotency, the pull feed |
| [5](#5-webhooks) | Webhooks — signatures, verification code, retries, dead letters, replay |
| [6](#6-mqtt) | MQTT — topics, QoS, retained state, security |
| [7](#7-exports) | Exports — equipment, BOM, hierarchy, maintenance, documents; CSV columns; readiness checks; integration bundle (one zip) |
| [8](#8-runtime-rules) | Runtime rules — state, alarms, counters, thresholds, shifts, OEE inputs, meters |
| [9](#9-opc-ua-security) | OPC UA security — modes, accounts, certificates |
| [10](#10-network-placement) | Network placement |
| [11](#11-acceptance-checklist) | Acceptance checklist to sign with the customer |
| [12](#12-security-model) · [13](#13-troubleshooting) · [14](#14-changes-in-this-release) | Security model · troubleshooting · changes in this release |

---

## 1. What integrates how

| | Pull feed `GET /integrations/events` | Webhook | MQTT | Exports (JSON / CSV) | OPC UA server | Part 2 REST |
|---|---|---|---|---|---|---|
| **MES** | Model and runtime events, replay from any cursor | State, alarm, counter, threshold, connection events in seconds | Same events on topics; retained state per machine | Process hierarchy (ISA-95 levels), equipment master | Live values by subscription | Read any submodel by id |
| **ERP** | `equipment.master.changed` with `changedKeys` | Same, pushed | — | Equipment master, BOM with ERP material numbers | — | — |
| **CMMS** | Alarm and counter events | Alarms to open work orders | — | Maintenance plan (job plans), documents with sha256 | — | — |
| **CMMS meters** | — | — | — | `GET /integrations/meters` (pull, daily) | — | — |

**What this tool never does** — so nobody plans an integration around it:

- It **never writes into** MES, ERP or CMMS. It publishes; the other system decides what to do.
- It **never commands machines.** The OPC UA server is read-only; PLC writes are not offered.
- It **never computes an OEE number.** `oee-inputs` gives run, stop, alarm and no-data times plus counter deltas; the
  availability / performance / quality definitions belong to the MES.
- It holds **no costs**, and it **never invents** maintenance intervals, locations or units. A value the model does not
  hold is exported as empty (`null`) and named in `missing`.

### VEXPLOR Logic Studio

[VEXPLOR Logic Studio](https://wace.me/en-platform-logic-studio) Cloud imports the AASX files themselves — drop a file
on its equipment screen, check the preview, import. Type and Instance files are imported separately, and dropping the
same file again changes nothing. No subscription, export or factory install is needed for this. Sending live values
from the remote collector to Logic Studio Cloud is in preparation and not offered yet.

## 2. Turning it on

The event log and the pull feed **always work** — every model change is recorded whether or not integrations are on.
Pushing (webhooks, MQTT), state detection and master-data notifications start only with `INTEGRATIONS=on`.

| Variable | Default | Effect |
|---|---|---|
| `INTEGRATIONS` | `off` | `on` starts state detection, master-data notifications and delivery. Always off in `DEMO_MODE` |
| `AAS_INTEGRATION_ALLOW` | empty | Comma list of CIDR / IP / host name, each optionally `:port`, allowed as **private** or **plain http / mqtt** targets; a listed port is also unblocked |
| `AAS_SECRET_KEY` | — | Base64 of 32 random bytes; seals webhook secrets and MQTT passwords. **Required with PostgreSQL** to create subscriptions. The folder store falls back to `<AAS_DATA_DIR>/secret.key` |
| `INTEGRATION_RETENTION_DAYS` | `30` | Event log retention by record time. Succeeded deliveries are kept 7 days, dead ones 30 |
| `INTEGRATION_TIMEOUT_MS` | `10000` | Total deadline of one webhook attempt, clamped to 1000–60000. DNS lookups time out after 5 s regardless |
| `OPCUA_ALLOW_INSECURE` | off | `on` restores the old unauthenticated OPC UA server (chapter 9) |
| `OPCUA_PKI_DIR` | `<AAS_DATA_DIR>/opcua-pki`, else `./opcua-pki` | OPC UA certificate store |
| `INTEGRATION_PROXY` | — | `http://[user:pass@]host:port`. Outside names go through it **unresolved** (HTTP CONNECT, TLS checked end to end against the name); internal names (no dot, `.local`, `.internal`, `.lan`, `.corp`, `.home.arpa`) and private addresses go direct under the rules above. Only https webhooks are tunnelled — MQTT brokers go direct (list them in `INTEGRATION_NO_PROXY`). The proxy resolves the name, so the proxy's own rules must refuse names that resolve to the site's internal addresses |
| `INTEGRATION_NO_PROXY` | — | Targets that go direct even with a proxy (same syntax as `AAS_INTEGRATION_ALLOW`) |
| `OPCUA_CLIENT_PKI_DIR` | `<AAS_DATA_DIR>/opcua-client-pki`, else `./opcua-client-pki` | The collector's OPC UA certificate store. Security mode, policy and whether a user name is needed come from the AID (AID 1.1 `securityDefinitions`). An unknown server certificate is refused and kept in `rejected/` until moved to `trusted/certs` |
| `OPCUA_CLIENT_TRUST` | — | `first-use` accepts a server certificate the first time it is seen |
| `OPCUA_CLIENT_CREDENTIALS` | — | JSON file `{ "<endpoint>": { "userName", "password" } }` for equipment whose AID asks for a user name. Shared by OPC UA and, from 2.8.0, MQTT brokers with "Login required" (key e.g. `mqtt://10.0.0.7:1883`). "Load from equipment" logs in with it too. Passwords never go into the AAS |
| `EDGE` | empty | Empty: an admin turns it on in Settings → Remote collectors (off until then). `on` always on, `off` always off (docs/edge-install.md) |
| `AAS_PUBLIC_URL` (existing) | — | Public address; event `dataschema`, links and document URLs become absolute when set |

```bash
# generate a master key once and keep it with the database backup
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

With Docker, put the values in `.env` (see `.env.example`); `docker-compose.yml` passes them through.

**The Integrations window** — Settings menu → **Integrations (MES · ERP · CMMS)**.

| Who | Sees |
|---|---|
| Administrator (signed-in session) | Status · Subscriptions (with deliveries) · Exports · Readiness · Rules · External references · OPC UA certificates |
| Editor | Feed address · Exports · Readiness · per-file Rules · External references (server rules read-only) |
| Viewer, read-only API key | Feed address · Exports · Readiness |

Subscriptions are created **only from an administrator session** — not from an API key, and not on an open server
without accounts (create the first administrator first). An outbound connection from an open server would turn it into
a relay anyone on the network could point anywhere.

## 3. Identity and join keys

**`globalAssetId` is the join key.** Every runtime and master-data event carries an `asset` block:

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

- `packageId` is internal and **not stable across re-imports** — never store it as a key.
- **Instance vs Type.** Only Instance shells are physical machines. Type shells (a model, not a machine) are excluded from
  the equipment export unless `includeTypes=1`, and then flagged.
- `serialNumber` comes from the DigitalNameplate `SerialNumber` (semanticId `0112/2///61987#ABA951#009`, then idShort)
  or is `null`. It is never invented.
- **specificAssetId names.** When a machine's other identities go into the AAS itself, use these names, always with an
  `externalSubjectId` naming the issuing system: `serialNumber`, `erpAssetNumber`, `cmmsEquipmentId`, `mesResourceId`,
  `erpMaterialNumber`, `manufacturerPartId`.

### External references — the ERP / MES / CMMS numbers

Internal numbers (SAP equipment number, functional location, cost centre, material, iCube code …) are kept **next to**
the AASX in an external-references document per file, **not inside the AASX** — AASX files leave the company (suppliers,
test labs), internal numbers should not.

```json
{ "system": "sap-s4:PRD:100", "type": "equipment", "id": "10002345", "publish": true,
  "externalSubjectId": "https://sap.example.com/PRD/100" }
```

- `system` names the system **including tenant / client** (`sap-s4:PRD:100`, `icube:WACE`). It must not contain `|`.
- One `(system, type, id)` belongs to **one** asset only. A second claim is refused with 409 and the existing holder.
- `publish: true` writes the ref into the shell's `specificAssetIds` as `name = "<system>:<type>"`, through a normal edit
  (history and a `model.shell.updated` event). Unpublishing removes it again; other specificAssetIds are untouched.
- A refs change is **not undoable** and clears the file's undo history (↶): undo restores the model only, so it would
  remove a published id while the refs document still says `publish: true`. To revert, save the refs again.
- `type: costCenter` (in any spelling — the type is stored as `costCenter`) and `sensitive: true` refs are **never**
  published, exported or put in events.
- Edit them in **Integrations → External references**, or import a CSV (columns
  `globalAssetId,subjectKind,subjectKey,system,type,id,publish,sensitive,externalSubjectId`). The import is always shown
  as a dry run first; it adds and updates only — it never deletes numbers missing from the file. Importing the same file
  twice changes nothing the second time. Row numbers count the header as line 1. An apply that still finds row errors
  or conflicts is refused whole (422 `ImportRejected`, same report, nothing changed).
- Deleting a file that has external references asks first; connected systems then receive
  `equipment.master.changed` with `operation: "removed"` (the ERP "retired" signal).

### Discovery flow

1. Look up the shell: `GET /api/v3.0/lookup/shells?assetIds=<base64url of {"name":"globalAssetId","value":"…"}>`
   (or a published `specificAssetId`, e.g. `sap-s4:PRD:100:equipment`).
2. Read its descriptor from the registry and **take the endpoint from the descriptor** — do not build URLs by hand.
3. Read submodels through Part 2.
4. Subscribe (webhook / MQTT) or poll the feed for changes.

Discovery matches only what is in the AAS (published refs included). Unpublished external references are not found by
lookup, on purpose: lookup and the AASX download must never disagree.

## 4. Events

### 4.1 Envelope — CloudEvents 1.0, structured JSON

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
  "vxchangeset": "chg_5f1d0c2e9a1b3c4d",
  "data": { }
}
```

| Field | Meaning |
|---|---|
| `id` | Unique event id — **dedupe on it** (= the `webhook-id` header) |
| `source` | `urn:vexplor-aas:<instanceId>` — 12 hex chars, stable across restarts |
| `subject` | Runtime / master-data events: the raw `globalAssetId`. Model events: `packages/<id>/<shells\|submodels\|concept-descriptions>/<base64url id>` |
| `dataschema` | Only when `AAS_PUBLIC_URL` is set |
| `sequence` | Store sequence, zero-padded to 20 digits. Monotonic, **not** gap-free (folder and PostgreSQL stores) |
| `vxrevision` | Package revision after the change (model events). A `model.package.deleted` event carries the last revision + 1 |
| `vxcause` | `edit`, `fix`, `import`, `undo`, `redo`, `derivation`, `external-refs`, `seed`, `system` |

Events are **thin**: identifiers, revisions, actor and links — never submodel content. Re-read the content through
Part 2 (`data.links.self`) or the export named in `href`.

### 4.2 Catalogue

All types are `kr.vexplor.aas.<name>.v1`. A payload shape never changes inside `.v1`; a change is a new `.v2` type.

| Name | Class | When |
|---|---|---|
| `model.package.created` / `.deleted` | model | A file is uploaded, created, cloned or deleted |
| `model.package.file.changed` | model | An attachment is put or removed |
| `model.shell\|submodel\|conceptdescription.created` / `.updated` / `.deleted` | model | Any edit, fix, undo, redo, import |
| `model.externalrefs.updated` | model | The file's external references (ERP/MES/CMMS numbers) were saved — `data` is only `packageId` and the refs `revision`; re-read the refs |
| `equipment.master.changed` | master data | The equipment-master projection changed (`changedKeys` lists the export columns) |
| `equipment.bom.changed` / `.maintenance.changed` / `.documents.changed` | master data | That projection changed; re-read `href` |
| `equipment.state.changed` | runtime | The judged state changed (`run`, `stop`, `alarm`, `off`, `unknown`) |
| `equipment.alarm.raised` / `.cleared` | runtime | A configured alarm rule raised / cleared. A cleared event sent because the rule was deleted while open carries `reason: "rule-removed"` (`clearedAt` = the cycle that noticed); an ordinary clear has no `reason` |
| `equipment.counter.advanced` | runtime | A configured counter advanced in a collection cycle |
| `equipment.threshold.crossed` / `.returned` | runtime | A configured threshold crossed / returned with hysteresis. Closed because the rule was deleted while open: `reason: "rule-removed"`, `value` / `observedAt` = the last value seen while open |
| `collection.connection.lost` / `.restored` | runtime | A collection interface failed N cycles in a row / recovered |
| `integration.audit` | audit | Subscription and configuration changes — in the feed for admins only, never delivered |
| `integration.ping` | test | Sent by "Send test"; never stored |

Example payloads:

```json
// equipment.state.changed.v1
{ "asset": { "…": "join block" }, "source": { "interfaceName": "PLC1", "propertyName": "MachineState",
    "address": "ns=1;s=Machine.State", "submodelId": "https://example.com/ids/sm/OperationalData",
    "idShortPath": "MachineState", "semanticId": "https://example.com/ids/cd/MachineState",
    "observableReference": { "type": "ModelReference", "keys": [
      { "type": "Submodel", "value": "https://example.com/ids/sm/OperationalData" },
      { "type": "Property", "value": "MachineState" } ] }, "simulated": false },
  "state": "alarm", "previousState": "run", "previousStateSince": "2026-10-14T01:12:40.002Z",
  "previousDurationMs": 1707310, "rawValue": "3", "ruleSetHash": "sha256:9a1c…",
  "observedAt": "2026-10-14T01:41:06.900Z", "receivedAt": "2026-10-14T01:41:07.300Z",
  "quality": "Good", "detectionResolutionMs": 30000, "suppressed": false }

// equipment.alarm.raised.v1
{ "asset": {}, "source": {}, "alarmRuleId": "alarm-main", "alarmInstanceId": "alm_…",
  "code": "E-217", "text": "Hydraulic pressure low", "severity": null,
  "raisedAt": "…", "detectedAt": "…", "clearedAt": null, "durationMs": null,
  "occurrences": 1, "maintenanceIds": [], "detectionResolutionMs": 30000, "suppressed": false }

// equipment.counter.advanced.v1
{ "asset": {}, "source": {}, "counterId": "produced", "counterKind": "total", "unit": null,
  "from": 15230, "to": 15241, "delta": 11, "intervalStart": "…", "intervalEnd": "…",
  "flags": { "reset": false, "rollover": false, "implausible": false, "gap": false }, "excludedBadSamples": 0 }

// equipment.master.changed.v1
{ "asset": {}, "operation": "updated", "changedKeys": ["nameplate.serialNumber"], "revision": 37,
  "projectionHash": "sha256:…", "href": "/integrations/exports/equipment?format=json&packageId=pkg_12" }

// model.submodel.updated.v1
{ "packageId": "pkg_12", "modelType": "Submodel", "id": "https://…/sm/TechnicalData", "idShort": "TechnicalData",
  "semanticId": "https://admin-shell.io/ZVEI/TechnicalData/Submodel/1/2", "operation": "update",
  "identifiableRevision": 5, "packageRevision": 37, "globalAssetId": "https://…/asset/press-03",
  "aasId": "https://…/aas/press-03", "actor": { "id": "user_3", "name": "Kim" },
  "links": { "self": "/packages/pkg_12/api/v3.0/submodels/aHR0cHM6Ly…" } }
```

Mapping to the AAS `EventPayload` names: `observableReference` keeps its name inside `data.source`;
`observableSemanticId` → `data.source.semanticId`; `source` → `data.asset.aasId` / `data.source.submodelId`;
`timeStamp` → `data.observedAt`. There are no duplicate alias fields. `submodelId`, `idShortPath`, `semanticId` and
`observableReference` are `null` when the collected tag does not resolve to a model element. Endpoint addresses have
their passwords masked (`mqtt://user:***@host`).

The JSON Schema of every type: `GET /integrations/schemas` (list) and `GET /integrations/schemas/{type}`.

### 4.3 Ordering, idempotency and guarantees

- Delivery is **at least once.** Keep received `id`s for at least 48 hours and ignore repeats.
- There is **no delivery ordering guarantee** — one slow receiver must not stall a plant. Every event carries
  `sequence`, `time` and (model events) `vxrevision`. For one package, ignore a model event whose `vxrevision` is not
  greater than the one already applied.
- The **pull feed is totally ordered** by `sequence`. Consumers that need order use it.
- `sequence` can have **gaps** on the folder and PostgreSQL stores: the event of a write that crashed half-way is voided
  (folder store), and a rolled-back transaction or a skipped duplicate still uses a number (PostgreSQL). **A gap is not
  data loss** — do not raise an alarm or re-sync because of it. Keep reading with the feed cursor (`nextAfter`); it never
  skips a committed event. The feed holds back rows after a fresh gap for up to 30 seconds so a late commit is still
  delivered in order.

### 4.4 The pull feed

```bash
curl -s -H "Authorization: Bearer $AAS_READONLY_TOKEN" \
  "https://aas.plant.local/integrations/events?after=0&limit=500&types=equipment.*"
```

```json
{ "items": [ { "…": "CloudEvent" } ], "nextAfter": "184223", "oldestSeq": "1000", "serverTime": "…" }
```

- Store `nextAfter` and pass it as `after` next time. An empty page returns your `after` unchanged.
- `types` takes exact types or prefixes ending in `*`; the `kr.vexplor.aas.` prefix may be left out.
- **410 Gone** — your cursor is older than the oldest retained event (`INTEGRATION_RETENTION_DAYS`). Do a full export
  (chapter 7), then continue from the `oldestSeq` the response gives.
- Any reader can poll the feed (viewer account, read-only key); a private workspace sees its own files only.

## 5. Webhooks

A webhook subscription POSTs each matching event to an HTTPS URL. Create it in **Integrations → Subscriptions**
(administrators): name, URL, event types (checklist or prefixes such as `equipment.*` — at least one), optionally the
files it covers. **The signing secret is shown once**; copy it into the receiver before closing the box.

Each request:

```
POST /hooks/aas HTTP/1.1
content-type: application/cloudevents+json; charset=utf-8
user-agent: VEXPLOR-AAS-Webhook/<version>
webhook-id: evt_3K7Q9ZB2M4XH8V0TQW5N6R1JPC
webhook-timestamp: 1791942067
webhook-signature: v1,oMzirs96Lr/DagsIw2/eRtl0GRxBE78Ohcay8i9L7MQ=

{ …CloudEvent… }
```

### 5.1 Verifying the signature

`webhook-signature` = `v1,` + base64(HMAC-SHA256(key, `"{webhook-id}.{webhook-timestamp}.{raw body}"`)), where
**key = the base64-decoded part of the secret after `whsec_`**. During a secret rotation the header carries two
signatures separated by a space; accept the request if **any** of them matches. Reject timestamps more than 5 minutes
from your clock, and compare in constant time. Sign the **raw bytes** you received — re-serialising the JSON changes them.

Test vector (use it to check your code):

| | |
|---|---|
| secret | `whsec_dmV4cGxvci1hYXMtdGVzdC12ZWN0b3Ita2V5LTMyYiE=` |
| webhook-id | `evt_3K7Q9ZB2M4XH8V0TQW5N6R1JPC` |
| webhook-timestamp | `1791942067` |
| body | `{"specversion":"1.0","type":"kr.vexplor.aas.integration.ping.v1"}` |
| webhook-signature | `v1,oMzirs96Lr/DagsIw2/eRtl0GRxBE78Ohcay8i9L7MQ=` |

**Node.js / TypeScript** (no dependencies):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(secret, headers, rawBody, now = Date.now()) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = String(headers['webhook-signature'] ?? '').split(' ');
  if (!id || !timestamp || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();
  return signatures.some((item) => {
    const [version, value] = item.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

**Python 3**:

```python
import base64, hashlib, hmac, time

def verify_webhook(secret: str, headers: dict, raw_body: bytes, now: float | None = None) -> bool:
    msg_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    if not msg_id or not timestamp or abs((now or time.time()) - int(timestamp)) > 300:
        return False
    key = base64.b64decode(secret.removeprefix("whsec_"))
    expected = hmac.new(key, f"{msg_id}.{timestamp}.".encode() + raw_body, hashlib.sha256).digest()
    for item in headers.get("webhook-signature", "").split(" "):
        version, _, value = item.partition(",")
        if version == "v1" and hmac.compare_digest(base64.b64decode(value), expected):
            return True
    return False
```

**Java** (JDK only):

```java
static boolean verify(String secret, String id, String timestamp, String signatureHeader, byte[] rawBody) throws Exception {
  if (Math.abs(System.currentTimeMillis() / 1000 - Long.parseLong(timestamp)) > 300) return false;
  byte[] key = java.util.Base64.getDecoder().decode(secret.replaceFirst("^whsec_", ""));
  javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
  mac.init(new javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"));
  mac.update((id + "." + timestamp + ".").getBytes(java.nio.charset.StandardCharsets.UTF_8));
  byte[] expected = mac.doFinal(rawBody);
  for (String item : signatureHeader.split(" ")) {
    String[] parts = item.split(",", 2);
    if (parts.length == 2 && parts[0].equals("v1")
        && java.security.MessageDigest.isEqual(java.util.Base64.getDecoder().decode(parts[1]), expected)) return true;
  }
  return false;
}
```

**C#** (.NET 6+):

```csharp
static bool Verify(string secret, string id, string timestamp, string signatureHeader, byte[] rawBody)
{
    if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - long.Parse(timestamp)) > 300) return false;
    var key = Convert.FromBase64String(secret.StartsWith("whsec_") ? secret[6..] : secret);
    var prefix = System.Text.Encoding.UTF8.GetBytes($"{id}.{timestamp}.");
    using var hmac = new System.Security.Cryptography.HMACSHA256(key);
    var expected = hmac.ComputeHash(prefix.Concat(rawBody).ToArray());
    foreach (var item in signatureHeader.Split(' '))
    {
        var parts = item.Split(',', 2);
        if (parts.Length == 2 && parts[0] == "v1" &&
            System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Convert.FromBase64String(parts[1]), expected))
            return true;
    }
    return false;
}
```

A complete reference receiver without dependencies is in `examples/webhook-receiver.mjs`: it verifies both signatures,
rejects old timestamps, dedupes ids for 48 hours and logs each event.

### 5.2 Responses, retries and dead letters

| Receiver answers | Result |
|---|---|
| 2xx | Delivered |
| Network / DNS / TLS error, timeout, 408, 425, 429, 5xx | Retried. A `Retry-After` header can only **lengthen** the wait (the longer of it and the schedule, at most 1 hour) |
| Any other 4xx | Dead at once — fix the receiver, then send again |
| 410 | Dead **and** the subscription is disabled ("410 from receiver") |
| 3xx | Failure — redirects are never followed |

Retry schedule (12 attempts, ±20 % jitter): immediately, 10 s, 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h, 8 h,
8 h — enough to cover a weekend MES shutdown. After the 12th failure the delivery is **dead**. A subscription with 50
dead deliveries in a row and no success for 72 hours is disabled; it is never deleted automatically.

In **Integrations → Subscriptions → Deliveries** you see every attempt (status code, error, duration, resolved address),
send a dead delivery again (same event id — the receiver dedupes it), or replay everything from a sequence number
(`POST /integrations/subscriptions/{id}/replay` with `{"fromSeq":"1000"}` or `{"from":"<ISO time>"}`). Only a
succeeded or dead delivery can be sent again; one that is pending or being sent answers 409 `DeliveryBusy`.

**Send test** sends a signed `integration.ping.v1` immediately and shows the status code, latency, resolved IP and the
first kilobyte of the answer. Nothing is stored in the event log.

**Rotate secret** issues a new secret; for 24 hours both the old and the new signature are sent, so the receiver can
switch without losing events. Rotating again while the previous secret is still valid answers 409 `RotationInProgress`.

## 6. MQTT

An MQTT subscription publishes to a broker (`mqtts://` recommended; `mqtt://` only to an allowlisted broker). Broker
credentials may be written in the URL as `user:password@`; the server strips them from the URL and stores them sealed.
Changing the subscription's URL to another scheme, host or port **drops the stored credentials** unless the new URL
carries `user:password@` again — so credentials never travel to a broker they were not given for.

| Topic | Payload | QoS / retain |
|---|---|---|
| `{prefix}/events/{type without kr.vexplor.aas.}` e.g. `vexplor/aas/9f2c4e1a7b3d/events/equipment.state.changed.v1` | The full CloudEvent | QoS 1, not retained. Success = PUBACK |
| `{prefix}/equipment/{base64url(globalAssetId)}/state` (only with "retained state") | `{ "state", "since", "eventId" }` | QoS 1, **retained** — a late subscriber gets the current state at once |
| `{prefix}/status` | `{"online": true, "since"}`; last will `{"online": false}` | retained |

`prefix` defaults to `vexplor/aas/<instanceId>`; it may not contain `+`, `#` or NUL and is at most 200 characters.

**Security note.** MQTT 3.1.1 has no headers, so the payload carries **no signature**. Protect it with `mqtts`
(TLS) and broker ACLs that let only this server publish under the prefix.

## 7. Exports

All exports: `format=json|csv` (default json). CSV is RFC 4180 (CRLF line ends, `.` decimals, ISO dates, formula
injection escaped). Multi-values are joined with `;` (`;` inside a value is written `\;`). Options: `bom=1` adds a UTF-8
byte order mark (Excel), `headers=keys|ko` (**keys are the contract**; `ko` gives labels for people, in the request language — Korean by default, English with `lang=en` or `Accept-Language`),
`meta=1` adds a first line `#schema=…`, `lang` picks the language of multi-language values (default `ko`, then `en`,
then the first). Two exports without edits differ only in `exportedAt`. In the UI: **Integrations → Exports**.

| Path | Schema | Notes |
|---|---|---|
| `GET /integrations/exports/equipment` | `vexplor.equipmentMaster/1` | One row per Instance shell; `packageId` optional (all visible files); `includeTypes=1`, `trace=1` (source paths), `profile=sap-pm` (length warnings) |
| `GET /integrations/exports/bom?packageId=` | `vexplor.bom/1` | Refused with 422 `BomRootMismatch` when INT-2 fails, 422 `NoBom` when the file has no hierarchy |
| `GET /integrations/exports/hierarchy?packageId=` | `kr.vexplor.aas.hierarchy.v1` | Any file with `HierarchicalStructures` (plant structure of a process file, or the BOM tree of an equipment file); flat list with parent ids. 422 `NoHierarchy` only when the file has none |
| `GET /integrations/exports/maintenance?packageId=` | `vexplor.maintenancePlan/1` | CSV has one row per step |
| `GET /integrations/exports/documents?packageId=` | `vexplor.documents/1` | One row per document × version × file |
| `GET /integrations/exports/bundle` | `vexplor.integrationBundle/1` | **Everything above in one zip** — see §7.4. `packageId` optional, JSON only |

### 7.1 Frozen CSV columns

Columns are only ever **added at the end**; any other change is a new schema `/2`.

| Export | Columns |
|---|---|
| Equipment | `key, aasId, assetKind, typeAasId, packageId, revision, nameplate.manufacturer, nameplate.productDesignation, nameplate.productFamily, nameplate.modelNumber, nameplate.orderCode, nameplate.serialNumber, nameplate.yearOfConstruction, nameplate.dateOfManufacture, nameplate.productUri, nameplate.markings, physical.weight.value, physical.weight.unit, location.path, location.isa95.site, location.isa95.area, location.isa95.workCenter, specificAssetIds, externalRefs, missing, warnings` |
| BOM | `rootKey, parentPath, childPath, childName, childGlobalAssetId, quantity, level, entityType, erpMaterial, mapped` |
| Hierarchy | `id, parentId, equipmentLevel, name, globalAssetId, aasId, packageId, serialNumber, quantity, specificAssetIds, warnings` |
| Maintenance | `maintenanceId, taskName, interval, intervalStatus, technicians, qualification, safety, stepSeq, stepId, stepName, instruction, durationValue, durationUnit, toolIds, consumableIds, documents, signatureRequired, sourceRef` |
| Documents | `documentId, documentDomainId, classId, className, classificationSystem, version, language, title, status, statusDate, issuer, fileName, contentType, size, sha256, available, url` |

Formats inside cells: `specificAssetIds` = `name=value;…`, `externalRefs` = `system|type|id;…`, `location.path` =
`/`-joined. BOM `quantity` is the child's `BulkCount` per parent (default 1); unmapped children are kept with
`mapped=false`. Hierarchy rows are never multiplied by a quantity. In a process file a quantity above 1 on equipment is
an INT-4 warning; in an equipment file's BOM tree a quantity is a part count and carries no warning.
Maintenance `interval` stays empty with `intervalStatus: "missing"` unless the model holds an explicit value and unit.
Documents `url` points at the Part 2 attachment route (absolute with `AAS_PUBLIC_URL`); a missing file part gives
`available=false` and an empty `url`.

### 7.2 ERP field hints — typical, verify per installation

| Export column | SAP PM (typical) | iCube (typical) | K-System (typical) |
|---|---|---|---|
| `key` / external ref `equipment` | Equipment number (EQUNR) | 설비코드 | 설비번호 |
| `nameplate.productDesignation` | Description (EQKTX, 40 chars — `profile=sap-pm` warns) | 설비명 | 설비명 |
| `nameplate.manufacturer` | Manufacturer (HERST) | 제조사 | 제조사 |
| `nameplate.serialNumber` | Manufacturer serial number (SERGE) | 제조번호 | 시리얼번호 |
| `nameplate.modelNumber` | Model number (TYPBZ) | 모델명 | 모델 |
| `nameplate.yearOfConstruction` | Construction year (BAUJJ) | 제작년도 | 제작년도 |
| `location.isa95.workCenter` | Work centre (ARBPL) / functional location (TPLNR) | 작업장 | 공정 |
| BOM `erpMaterial` | Material (MATNR) | 품번 | 품목코드 |

These labels are typical names seen in installations, not a contract. Confirm each field with the customer's ERP team.

### 7.3 Readiness checks

`GET /integrations/readiness[?packageId=]` and **Integrations → Readiness** show what would make an export wrong or
refused. They are not lint findings and do not change the submission report.

| Id | Severity | Condition | Effect |
|---|---|---|---|
| INT-1 | warning | A Type shell has a DigitalNameplate `SerialNumber` | Excluded from the equipment export unless `includeTypes=1` |
| INT-2 | error | The hierarchy entry node's `globalAssetId` differs from the shell's | BOM export refused (422 `BomRootMismatch`) |
| INT-3 | warning | A maintenance instruction has no explicit interval value + unit | `intervalStatus: "missing"` |
| INT-4 | warning | A process-file hierarchy node with `BulkCount > 1` points at one `globalAssetId` | Hierarchy export warning; never expanded |
| INT-5 | warning | An Instance shell has no `SerialNumber` | `missing` includes `nameplate.serialNumber` |

### 7.4 Integration bundle — everything in one file

For a receiving system that wants the whole picture in one step (an ERP or CMMS import job, a VEXPLOR Logic Studio
tenant) instead of five calls per file. In the UI: **Integrations → Exports → Download everything (zip)**.

```
manifest.json                          vexplor.integrationBundle/1
equipment.json                         vexplor.equipmentMaster/1 — Type shells included (assetKind says which)
packages/<packageId>/hierarchy.json    kr.vexplor.aas.hierarchy.v1
packages/<packageId>/bom.json          vexplor.bom/1
packages/<packageId>/maintenance.json  vexplor.maintenancePlan/1   (left out when empty)
packages/<packageId>/documents.json    vexplor.documents/1         (left out when empty)
```

- Each part is **exactly** the JSON the single export route answers — the bundle is a carrier, not a second
  projection. All parts share the manifest's `exportedAt`; two bundles without edits differ only in that value.
- `manifest.parts[]` lists every entry with `sha256` and the item count — check them before importing.
- An export a file refuses (422 `NoHierarchy`, `NoBom`, `BomRootMismatch`) appears in `manifest.skipped[]` with the same
  code and message, so the receiver can show why a part is missing. For hierarchy and BOM a part is always either
  present or listed there.
- Same access as the exports: any reader, limited to the files the workspace shows. Document files themselves are not in
  the zip — `documents.json` carries their download address and `sha256`.

**Without a server — `@aas/bundle`.** A product that takes AASX files directly (drag and drop) builds the same bundle
with `buildBundle(files, { exportedAt, lang })` from the `@aas/bundle` release tarball. It runs this API's own export
code over an in-memory store, so the same files in the same order with the same `exportedAt` give the same zip byte
for byte (checked against the route in `apps/api/test/integration-bundle-build.test.ts`). Package ids follow the input
order (`pkg_1`, `pkg_2`, …); document links are relative unless `publicBaseUrl` is given.

**Read list without a server — `aidReadList`.** The same tarball has `aidReadList(environment, packageId, intervalMs?)`:
the AID interfaces of one file resolved into the tags a remote collector reads (`docs/edge-contract.md` §4) — the
server's own read-list code, so the same `packageId` gives the same stable `tagId`s (checked against the edge endpoint
in `apps/api/test/edge-endpoints.test.ts`). A product that builds its own read list from AASX files needs no AID parser.
Since 2.5.0 each tag also carries hints — the model element's `semanticId`, a `suggestedRole` (`run_state` ·
`counter` · `alarm_source` · `meter` · `condition` · `quality` · `value`) and `limits` from the same file — so a receiver
can pre-fill roles and specification limits for a person to confirm (`docs/edge-contract.md` §4.1).

**Type link (`typeAasId`).** An Instance row names its Type by the server's link ("link to type") when there is one,
otherwise by the shell's own AAS `derivedFrom` reference — which "split per unit" writes and which travels inside the
file, so `buildBundle` sees it too. The id is taken as written; the Type may be in another file or not exported.
Type rows have `typeAasId` null unless the server links them.

**Sample.** `docs/examples/integration-bundle/` holds four AASX files (a Type, two Instances made from it, a company file
placing both on a line) and the bundle built from them. Receivers run their import gate on it; the test above fails
when the sample and the code disagree.

## 8. Runtime rules

Runtime events come from collected values (chapter 8 of [usage.md](usage.md)) judged by **rules on the server**. The
same rules draw the daily status bar in the UI, so the bar and the events always agree.

**Server rules** (administrators, **Integrations → Rules**): the words that mean running / stopped / alarm / power off,
the time zone (`Asia/Seoul` by default), the hour the day starts (8) and the shift calendar
(e.g. A 08:00–20:00, B 20:00–08:00). A value not in the rules is `unknown` — never guessed as stopped.
Each state event carries `ruleSetHash`, so a receiver can tell which rule set judged it.

**Per-file rules** (editors): the state tag (also chosen in the daily status bar), an optional rule override for that
file, and:

| Rule | Behaviour |
|---|---|
| Alarm | Active when the tag is truthy (true / 1 / non-zero) or equals listed values. Raised after `raiseSamples` consecutive active cycles, cleared after `clearSamples` inactive ones. One open instance per rule; a re-raise while open counts `occurrences`. `code` / `text` come from named tags or are `null` |
| Counter | `to − from` per cycle. A decrease is a **rollover only when `max` is set** (65530 → 4 with max 65535 = 10); otherwise `reset: true, delta: null`. `maxRatePerHour` flags implausible jumps (`delta: null`). A previous sample older than the freshness window sets `gap: true` |
| Threshold | `above`: crossed when value > limit for `raiseSamples` cycles; returned when value < limit − hysteresis for `clearSamples` cycles (`below` mirrored) |
| Suppression | When the maintenance-mode tag is true, events are still sent, with `suppressed: true` |
| Connection | `lost` after N consecutive failed cycles of one interface (default 2), `restored` on the next success. Bad tags alone never mean lost |

**Detection resolution and short alarms.** Values are polled every collection interval; `detectionResolutionMs` in each
event says how fine that is. An alarm shorter than the interval can be missed between two polls. For short alarms, use
a **latched PLC counter** (an alarm count that only increases) as a counter rule, so no occurrence is lost.

**OEE inputs** — `GET /integrations/equipment/oee-inputs?packageId=…&day=2026-10-14[&shift=A]` returns run, stop, alarm,
off, unknown and no-data milliseconds, `coverage` (share of the window with data), `resolutionMs` and the `produced`,
`good`, `reject` counter deltas. **No OEE number** — availability, performance and quality depend on definitions (planned
stops, ideal cycle time) that belong to the MES.

**State segments** — `GET /integrations/equipment/segments?packageId=…&from=…&to=…` (≤ 31 days).

**Meters for CMMS** — `GET /integrations/meters?packageId=…&counter=<id|runtime>&period=day` returns one reading per
period with a deterministic `readingId` (safe to re-import) and an `evidence` link to the raw values. The id is built from
the **receive time** of the sample read, so a counter whose device clock is stuck still gets a new id each period.
`counter=runtime` gives computed run time with running / stopped / alarm / off / unknown seconds.

**Limits of these three reads** — they read stored values, so they are bounded: **422 `TooManyValues`** when one request
would read more than 200 000 values (shorten the window), **422 `TooManyPeriods`** when meters would return more than
1 000 periods, and **503 `Busy`** with `Retry-After: 5` when more than two such reads run at once — wait the given seconds
and ask again. Results are never silently cut short.

## 9. OPC UA security

**Secure by default** when `OPCUA_SERVER=on`:

- Security policies `Basic256Sha256`, `Aes128_Sha256_RsaOaep`, `Aes256_Sha256_RsaPss`; modes `Sign` and
  `SignAndEncrypt`. No `None` endpoint.
- **No anonymous sessions.** Users sign in with the tool's **web accounts** (any role — the server is read-only), as a
  **UserName** token only — X.509 user certificates are not accepted as a user identity.
  Locked accounts are refused; repeated wrong passwords are throttled like web login.
- If no account exists yet, the OPC UA server **does not start** and the startup log says why — create the first
  administrator first.
- `OPCUA_ALLOW_INSECURE=on` restores the old unauthenticated server with a startup warning. Use it only on an isolated
  test network.

**Trusting a client certificate (UaExpert example)**

1. In UaExpert add the server `opc.tcp://<host>:<port>/UA/AAS`, choose `Basic256Sha256 – SignAndEncrypt`, user name and
   password = a web account.
2. The first connection fails: the server has put the client certificate under "rejected".
3. In **Integrations → OPC UA certificates**, compare the thumbprint with the one UaExpert shows
   (Settings → Manage Certificates), then **Trust**.
4. Connect again. Also trust the server certificate in UaExpert when it asks.

The certificate store is `OPCUA_PKI_DIR` (default `<AAS_DATA_DIR>/opcua-pki`). In Docker it is inside the container
unless you mount a folder and point `OPCUA_PKI_DIR` at it; otherwise a rebuild means trusting clients again.

## 10. Network placement

```
 L4  ERP · CMMS (business network)        ◀── exports, pull feed (HTTPS), webhooks to an L4 endpoint via the DMZ
 L3.5  DMZ / reverse proxy                ◀── publish AAS_PUBLIC_URL here; terminate TLS
 L3  MES · historian · VEXPLOR AAS Studio ◀── webhooks / MQTT to the MES, OPC UA server for SCADA
 L2  SCADA · HMI
 L1/L0  PLCs, machines                    ──▶ collected by the tool (read only)
```

- Place the tool at **level 3** next to the MES. It reads PLCs below and publishes upward; nothing above writes down.
- Prefer **pull** (feed, exports) across the DMZ toward level 4 — the business network asks, the plant answers.
  Use **push** (webhook, MQTT) inside level 3 or to an endpoint the DMZ exposes on purpose.
- Plant-internal targets (private addresses, plain http, internal brokers) must be listed in `AAS_INTEGRATION_ALLOW`.
- The folder store's integration guarantees assume a **local disk**. Network file systems (SMB, NFS, NAS sync folders)
  have weaker rename / fsync behaviour; use PostgreSQL there.

## 11. Acceptance checklist

Sign this with the customer before go-live.

| # | Item | Agreed value |
|---|---|---|
| 1 | Join key per system (globalAssetId, or which external reference `system:type`) | |
| 2 | Instance vs Type: which files are machines | |
| 3 | State rules (words per state) and the `ruleSetHash` the MES expects | |
| 4 | Time zone, day start, shift calendar | |
| 5 | Delivery mode per system (pull feed / webhook / MQTT / export schedule) | |
| 6 | Event types and files per subscription | |
| 7 | Secret exchange: who received the signing secret, how it is stored, rotation date | |
| 8 | Allowlist entries (`AAS_INTEGRATION_ALLOW`) and firewall openings | |
| 9 | Test ping succeeded from the production server (status code, latency, address) | |
| 10 | Receiver dedupes on `id` for ≥ 48 h and verifies signatures with the test vector | |
| 11 | Who watches dead deliveries and how often | |
| 12 | OPC UA: accounts used by clients, trusted certificate thumbprints | |

## 12. Security model

- **Who may do what**: subscriptions, status, server rules and certificates — administrator **session** only (not API
  keys, not open servers). Per-file rules and external references — editors. Feed and exports — any reader, limited to
  the files the reader's workspace may see. Audit events in the feed — administrators only.
- **Subscriptions are server-wide.** A subscription receives the matching events of **every workspace**, also on a server
  with `AAS_WORKSPACE=private`. Workspace separation applies to people reading the feed and exports, not to what an
  administrator subscribes to. Narrow a subscription with its file filter when one customer's data must not reach another
  system.
- **Egress (SSRF) policy**: loopback, link-local, multicast, broadcast and their IPv6-mapped forms are always refused;
  private ranges, special-purpose ranges (`192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`,
  `203.0.113.0/24`, `2001:db8::/32`, `100::/64`, `2001::/23`, `64:ff9b:1::/48`, `::ffff:0:0:0/96`) and plain http / mqtt
  only when allowlisted; ports such as 22, 25, 445, 502, 1433, 3306, 3389, 5432,
  6379 and 44818 are refused unless the allow entry names the port. DNS is resolved once per attempt, every answer is
  checked, and the connection goes to the checked address (no DNS rebinding). Redirects are never followed.
- **Secrets**: webhook secrets and MQTT passwords are sealed with AES-256-GCM under the master key; they never appear in
  listings, logs, delivery rows or audit events. A secret is shown once, at creation or rotation. Audit details mask URL
  query values (`?token=***`); the full URL is shown only by the subscription GET (administrators). Subscription
  responses carry `Cache-Control: no-store`. When secrets were sealed under another `AAS_SECRET_KEY`, the status lists
  those subscriptions in `masterKeyMismatch` — restore the right key, or rotate their secrets.
- **Thin events**: no submodel content leaves through events; receivers read content with their own credentials.
- **Demo mode**: integrations are always off and every outbound target is refused.

## 13. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Create an admin first" / 403 on subscriptions | Open server or API key. Sign in as an administrator (create the first one in Settings) |
| 422 `TargetNotAllowed` | Private address, plain http/mqtt or a blocked port. Add the host or CIDR (with `:port` if needed) to `AAS_INTEGRATION_ALLOW`, restart |
| 503 `MasterKeyMissing` | PostgreSQL without `AAS_SECRET_KEY`. Generate one (chapter 2), restart |
| Status lists subscriptions under "sealed with another key" | `AAS_SECRET_KEY` changed. Put the old key back, or rotate those secrets and update the receivers |
| 503 `IntegrationsOff` | The feature needs workers. Set `INTEGRATIONS=on`, restart |
| Receiver rejects every signature | Signing a re-serialised body, or using the secret text instead of the base64-decoded bytes. Check with the test vector |
| Deliveries dead with 401/403 | The receiver's own authentication refuses us — fix it, then "Send again" |
| Subscription disabled "410 from receiver" | The receiver said the endpoint is gone. Fix the URL, enable it again |
| 410 Gone on the feed | Cursor older than retention. Full export, then continue from `oldestSeq` |
| No state events | `INTEGRATIONS` off, no state tag chosen for the file, or collection not running |
| Many `unknown` states | The machine sends words not in the rules. Add them in Integrations → Rules |
| BOM export 422 | INT-2 — fix the hierarchy entry node's `globalAssetId` to the shell's |
| UaExpert "BadSecurityChecksFailed" | Its certificate is in "rejected" — trust it in Integrations → OPC UA certificates |
| OPC UA server did not start | No account exists. Create the first administrator, restart (or `OPCUA_ALLOW_INSECURE=on` on a test network) |

## 14. Changes in this release

- **AASX downloads carry a metamodel version (2.9.0).** The package download (`GET /packages/{id}`), the Part 2
  serialization as AASX and the bundle ZIP write each file as the version it came in as (V3.0 · V3.1 · V3.2; models
  made in the app are V3.1). On the download and the serialization, `?metamodel=3.0|3.1|3.2` picks another; a value that version cannot express answers 422
  `Unrepresentable` with the report, `&unrepresentable=keep` writes it anyway. The version written is in the response
  header `x-aas-metamodel-version`. A system that only reads V3.0 should ask for `?metamodel=3.0`.
- **Part 2 also under `/api/v3` (2.9.0)** — the alias V3.1 · V3.2 clients use. Links in responses (registry endpoints)
  still say `/api/v3.0`; both answer. Part 2 JSON responses are not converted between versions: a V3.2 model is served
  with its V3.2 fields.
- **Unchanged in 2.9.0:** events, the pull feed, exports and the integration bundle's JSON carry no metamodel version,
  and their schemas are the same, so `vexplor.edge/1` and existing consumers need no change.
- **OPC UA is secure by default.** Clients must sign in with a web account over `Sign` or `SignAndEncrypt`; anonymous
  sessions and the `None` policy are gone. Set `OPCUA_ALLOW_INSECURE=on` to keep the old behaviour while clients are
  migrated.
- **Discovery: `name` is required.** `GET /lookup/shells` answers 400 for an asset id without `name`, and a
  `globalAssetId` query now matches only the shell's `globalAssetId` (before, it also matched any specificAssetId with the
  same value).
- **Daily status rules moved to the server.** Rules kept in a browser are offered to an administrator once ("Move
  browser rules to the server"); after that every screen and every state event uses the server rules.
- **Integration bundle.** `GET /integrations/exports/bundle` (UI: Integrations → Exports → Download everything) gives every
  export of the visible files in one zip with a manifest (§7.4).
- **Libraries for other products.** `@aas/core`, `@aas/aasx` and `@aas/linter` are packed for the release
  (`scripts/pack-libraries.mjs`) — install by release URL (README, "Using the libraries in another product").
- **Remote collectors (`EDGE=on`).** The edge contract `vexplor.edge/1` (docs/edge-contract.md), its endpoints, the
  management routes and the mock edge `scripts/mock-edge.mjs`.
- **OPC UA security when collecting.** Mode, policy and user name from the AID 1.1 `securityDefinitions`; certificate
  store, first-use trust and credentials by endpoint (`OPCUA_CLIENT_*`).
- **Webhooks through a proxy.** `INTEGRATION_PROXY` / `INTEGRATION_NO_PROXY` — HTTP CONNECT, rules on the destination name.
- **Collected values keep an idempotency key (database schema version 10).** A value sent again with the same key is
  stored once — PostgreSQL adds `value_key` and a unique index at startup; values without a key are unchanged.
- **AID protocol by supplementalSemanticId.** The interface's protocol comes from its supplementalSemanticId (AID 1.1),
  then the endpoint scheme, and only last from the idShort. BACnet is recognised and not collected yet.
- **Type link from `derivedFrom`.** The equipment master now fills `typeAasId` from an Instance shell's `derivedFrom`
  when the server has no link of its own (before, it stayed null for units uploaded as files). `typeAasId` is part of
  the equipment digest, so such a unit gives one equipment-updated event the next time it is projected.
- **Bundle without a server.** `@aas/bundle` (`buildBundle`) builds the integration bundle from AASX files with this
  API's own export code; a sample bundle is in `docs/examples/integration-bundle/` (§7.4).
- New: event log and pull feed, webhook and MQTT subscriptions, exports, external references, readiness checks, runtime
  rules, OEE inputs, meters.
