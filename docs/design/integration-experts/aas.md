# AAS standards expert opinion — MES / ERP / CMMS integration for VEXPLOR AAS Studio

Scope read: README "Standards", docs/spec/part2 (v3.0.4 yaml), apps/api/src/routes/part2.ts and registry.ts,
packages/api values route, packages/linter rules (l2-constraints, l3-kosmo-aas), docs/usage.md §8-5/§8-6,
and `node scripts/part2-coverage.mjs --all` (run 2026-10-14). No repository file was edited.
Statements I cannot confirm against a normative text are marked [unverified].

## 0. Verdict in one paragraph

The read side of Part 2 is already where an integrator needs it (all repository reads, $value, $metadata,
$path, $reference, ConceptDescription, AASX file server, lookup/shells read). What blocks clean MES/ERP/CMMS
integration is not missing CRUD but three things: (1) a defined convention for external system ids as
specificAssetIds plus one discovery matching fix, (2) a change/value notification payload that references
standard AAS identifiers (V3.0 Part 2 defines no eventing API), and (3) value history exposed through the
IDTA Time Series submodel instead of only the private `/packages/{id}/values` route. Operation invocation and
registry write operations are "later".

## 1. Coverage output — which missing Part 2 operations matter

Coverage: AasxFileServer 6/6, ConceptDescription 7/7, AAS Repository 47/54, Submodel Repository 38/45,
AAS Registry 5/11, Submodel Registry 3/6, Discovery 3/5. 25 missing, 0 status-code mismatches,
0 non-spec paths under the spec bases.

| Missing | Count | Priority | Why |
|---|---|---|---|
| `/invoke`, `/invoke/$value`, `/invoke-async`, `/invoke-async/$value`, `/operation-status/{}`, `/operation-results/{}`, `/operation-results/{}/$value` (AAS repo + SM repo) | 14 | **later** | Only meaningful if the model contains `Operation` elements that are bound to real behaviour. For MES/ERP/CMMS the realistic uses are "acknowledge alarm", "request maintenance order", "start job". Writing to machines from an authoring tool is a safety decision, not a coverage gap. If implemented, implement async first (status/results) — synchronous invoke over HTTP to a PLC is a timeout trap. Until then answer 501 with the Part 2 `Result`/`Message` body, which a client can handle. |
| `POST/PUT/DELETE /shell-descriptors`, `.../submodel-descriptors` (AAS registry) | 6 | **later** (by design) | Our registry is *derived* from stored packages. Writable descriptors would create a second source of truth that drifts from the AASX. Integrators that only find and read do not need them. Keep read-only and advertise the read profile (see §1.1). Implement only if a customer runs a central registry fed by several repositories. |
| `POST/PUT/DELETE /submodel-descriptors` | 3 | **later** | Same reason. |
| `POST /lookup/shells/{aasId}`, `DELETE /lookup/shells/{aasId}` (Discovery) | 2 | **should** | This is the one write operation an ERP/CMMS integrator actually wants: "attach my asset number to this AAS" without re-editing the file. But it must write *into* `assetInformation.specificAssetIds` of the stored AAS (same source of truth), not into a side table, otherwise the AASX download and the lookup disagree. If that is not acceptable, leave it out and document "edit specificAssetIds in the editor". |

### 1.1 Must: advertise the profiles you actually satisfy
`/description` currently advertises only AasxFileServer SSP-001 and ConceptDescription SSP-001.
Part 2 defines read-only profiles for repositories and registries (e.g. `...ServiceSpecification/SSP-002`
"read") [unverified: exact profile ids and whether every repo read op is included — check the
`x-profile`/description sections of the bundled v3.0.4 yaml before adding]. If all read operations of a
read profile are implemented (the coverage list suggests yes for AAS/SM repository; invoke is POST and
normally not part of a read profile), advertise it. Integrators and test engines decide from `/description`
what to call; under-advertising makes a capable server look incapable.

### 1.2 Must: one integrator-facing note on base paths
The repository base is `/packages/{packageId}/api/v3.0` (per package), the registry/discovery base is
`/api/v3.0`. That is legal, but an integrator must take the endpoint from the descriptor
(`endpoints[].protocolInformation.href`), never construct it. State this in the integration doc and make
sure descriptor hrefs are absolute and stable across restarts (they are built from `baseUrlOf(request)`;
behind a reverse proxy this needs a configured public base URL, otherwise descriptors leak internal hosts).

## 2. Eventing / notification in V3.0 — what is standard

What I am sure of:
- **Metamodel V3.0 (IDTA-01001-3-0)** defines `BasicEventElement` (attributes: `observed` (ModelReference),
  `direction` (input/output), `state` (on/off), `messageTopic`, `messageBroker` (ModelReference),
  `lastUpdate`, `minInterval`, `maxInterval`) and an `EventPayload` class (`source`, `sourceSemanticId`,
  `observableReference`, `observableSemanticId`, `topic`, `subjectId`, `timeStamp`, `payload`).
  The event part is explicitly marked **experimental** in V3.0.
- **Part 2 V3.0 (IDTA-01002-3-0, v3.0.4 yaml in the repo)** defines **no** subscription, webhook, SSE or
  MQTT interface. There is no change feed, no "modified since" filter in the HTTP API.
- OPC UA subscriptions (what §8-6 does) are a valid way to notify on value change, but the address space is
  our own mapping, not the "OPC UA for AAS" companion spec, unless it is implemented to that spec
  [unverified whether ours follows OPC 30270].

What exists but I cannot confirm as normative V3.0:
- Eclipse BaSyx publishes MQTT repository events with its own topic scheme
  (roughly `aas-repository/<repo>/shells/<base64 id>/created|updated|deleted`, `sm-repository/.../submodelElements/<idShortPath>/updated`)
  — implementation convention, not IDTA [unverified exact topic strings].
- IDTA work on asynchronous interfaces / eventing (MQTT, AsyncAPI) beyond V3.0 [unverified: no published
  normative V3.0 spec I can cite].

### 2.1 Recommendation for our webhook / MQTT payloads (must)
Because nothing normative fixes the transport, make the **payload** mirror `EventPayload` field names so
that a later standard mapping is a rename at most. Use "notify, then fetch via Part 2": the event says what
changed; the integrator re-reads through the standard API.

```json
{
  "specVersion": "vexplor-aas-event/1",
  "type": "value.changed",            // or model.submodel.updated, model.element.created/deleted, collection.failed
  "timeStamp": "2026-10-14T05:12:03.120Z",   // UTC, xs:dateTime
  "source": {                          // EventPayload.source as ModelReference
    "type": "ModelReference",
    "keys": [{ "type": "Submodel", "value": "<submodelId>" }]
  },
  "sourceSemanticId": null,
  "observableReference": {
    "type": "ModelReference",
    "keys": [
      { "type": "Submodel", "value": "<submodelId>" },
      { "type": "SubmodelElementCollection", "value": "Spindle" },
      { "type": "Property", "value": "Speed" }
    ]
  },
  "observableSemanticId": { "type": "ExternalReference", "keys": [{ "type": "GlobalReference", "value": "<element semanticId>" }] },
  "aasId": "<aas id>",                 // extra: a submodel can be referenced by several AAS
  "globalAssetId": "<asset id>",       // extra: lets ERP/CMMS route without a lookup
  "submodelId": "<submodelId>",
  "idShortPath": "Spindle.Speed",      // Part 2 notation: dots, [n] for SubmodelElementList
  "topic": "<optional, = messageTopic if a BasicEventElement declares it>",
  "subjectId": null,
  "payload": { "value": "1450", "valueType": "xs:double", "quality": "good" },
  "links": {                           // convenience, absolute, base64url ids without padding
    "element": "https://<host>/packages/<pkg>/api/v3.0/submodels/<b64url submodelId>/submodel-elements/Spindle.Speed/$value"
  }
}
```

Rules:
- Ids in the payload are **raw** strings; only URLs carry base64url (unpadded), exactly like Part 2.
- `idShortPath` uses Part 2 notation and is **not** URL-encoded in the payload.
- First key of a ModelReference must be an Identifiable (Submodel or AAS) — do not start it with the
  package id or the file name.
- Always include the element `semanticId` when the element has one: CMMS/MES mappings should bind to
  semanticId, not to idShort (idShort is renamed by KOSMO auto-fix, semanticId is not supposed to be).
- MQTT topic suggestion (ours, documented as ours): `vexplor/aas/<b64url aasId>/submodels/<b64url submodelId>/elements/<idShortPath>/<event>`;
  publish value events with QoS 1, not retained, model events retained=false; never put secrets in topics.
- Optional (should/later): declare a `BasicEventElement` per published topic in the AAS (direction=output,
  `observed` = the element or submodel, `messageTopic` = the topic, `messageBroker` = reference to a
  broker description). That makes the event channel discoverable from the model itself. Because the
  element is experimental in V3.0, check the KOSMO Validator and aas-test-engines accept it before adding it
  to submission files — keep it in a separate, non-submitted integration submodel if in doubt.

## 3. How integrators find things — discovery and external ids

### 3.1 Storing ERP / CMMS / MES ids (must)
Put them in `assetInformation.specificAssetIds` of the AAS (Type AAS for the model, Instance AAS for the
physical machine — external ids belong to **instances**; an ERP material number may belong to the Type).

| name (our convention) | value example | externalSubjectId (ExternalReference, GlobalReference) | Instance / Type |
|---|---|---|---|
| `serialNumber` | `SN-2026-00412` | manufacturer IRI (who issued it) | Instance |
| `erpAssetNumber` | `100023456` | IRI of the ERP system/company code, e.g. `https://<customer domain>/systems/erp/<companyCode>` | Instance |
| `cmmsEquipmentId` | `EQ-CNC-07` | IRI of the CMMS tenant | Instance |
| `mesResourceId` | `LINE2-CNC07` | IRI of the MES site | Instance |
| `erpMaterialNumber` | `M-4711` | IRI of the ERP system | Type |
| `manufacturerPartId` | order code | manufacturer IRI | Type |

Notes:
- `name` is a free string in V3.0. The pair (`name`, `externalSubjectId`) is what makes it unambiguous —
  two plants can both have equipment id `EQ-07`. Always set `externalSubjectId` for system-specific ids.
- Constraints enforced by our linter already: AASd-116 (`globalAssetId` is reserved as a name) and
  AASd-133 (`externalSubjectId` must be an ExternalReference) — rule `aasdSpecificAssetId` in
  packages/linter/src/rules/l2-constraints.ts. Good.
- `SpecificAssetId` is HasSemantics in V3.0; a `semanticId` may be added. I know of no IDTA-published IRI
  for "ERP asset number" or "CMMS equipment id" — **do not invent one into submission files**; leave it
  empty or use our own IRI root and mark it as ours. Catena-X uses names such as `manufacturerPartId`,
  `partInstanceId`, `customerPartId` in its Digital Twin Registry [unverified exact list]; reusing
  `manufacturerPartId` costs nothing.
- Never store credentials, personal data or prices as specificAssetIds — they are returned unauthenticated
  by `/lookup/shells/{id}` in many deployments.

### 3.2 KOSMO compatibility
The only KOSMO rule touching this is `KOSMO-AAS-5` (packages/linter/src/rules/l3-kosmo-aas.ts): error if
neither `globalAssetId` nor any `specificAssetIds` exists. Nothing in our KOSMO rules forbids or restricts
additional specificAssetIds, so the convention above passes our linter. Recommendation: keep
`globalAssetId` (KOSMO's auto-fix form `<iriBase>/asset/<name>/<version>/<revision>` for Type; for Instance
use a per-unit IRI) **and** add specificAssetIds — do not rely on specificAssetIds alone to satisfy
KOSMO-AAS-5, because the remedy text and the KOSMO reviewer expect globalAssetId. Whether the KOSMO
Validator itself warns on unknown specificAssetId names: [unverified] — test one file with the validator
before rolling out.

### 3.3 Discovery matching — fix (must)
`registry.ts` GET `/lookup/shells`: a query entry with `name: "globalAssetId"` currently matches **any**
link value (`want.name === 'globalAssetId' || link.name === want.name`). So asking for globalAssetId
`EQ-07` returns an AAS whose CMMS id happens to be `EQ-07`. Per Part 2 the name must match: globalAssetId
queries should match only the AAS `globalAssetId`. Also, when an entry has no `name`, the code defaults it
to `globalAssetId`; the spec's SpecificAssetId requires `name`, so a missing name should be 400, not a
silent global match. Additionally, matching ignores `externalSubjectId`; that is acceptable for read
(spec matching is on name/value), but document it so integrators always use system-specific names.

### 3.4 Integrator flow (document this)
1. ERP/CMMS holds its own id → `GET /api/v3.0/lookup/shells?assetIds=<b64url {"name":"cmmsEquipmentId","value":"EQ-CNC-07"}>` → AAS id(s).
2. `GET /api/v3.0/shell-descriptors/<b64url aasId>` → endpoint href + submodel descriptors (filter by submodel semanticId, not idShort).
3. Read via repository (`$value` for values, `?live=true` only if they accept that file and live values are merged, see §8-5).
4. Subscribe via webhook/MQTT/OPC UA for changes; re-read on event.

## 4. Time Series Data (IDTA-02008) for history export (should)

Yes — expose history as a TimeSeries submodel whose segment **links** to our values API. Do not copy
history into the AAS (InternalSegment) — it bloats the AASX and turns the model into a data store.

Minimal correct structure (TimeSeries V1.1):
```
Submodel TimeSeries            semanticId https://admin-shell.io/idta/TimeSeries/1/1
  Metadata (SMC)
    Name (MLP), Description (MLP)
    Record (SMC)               one Property per variable, each with the semanticId of the source element
      Time  (Property, xs:dateTime) – UTC time
      Speed (Property, xs:double)
  Segments (SMC)
    LinkedSegment (SMC)
      Name, Description
      RecordCount / StartTime / EndTime (optional)
      Endpoint (Property, xs:string) = https://<host>/packages/<pkg>/values
      Query    (Property, xs:string) = interface=<aid interface>&property=<tag>&from={start}&to={end}
```
Things I am sure of: the submodel-level semanticId above for V1.1 and the concepts Metadata/Record,
Segments, Internal/Linked/External segment, Endpoint + Query on LinkedSegment. Exact semanticIds of
Record, Segments, LinkedSegment, Time (UtcTime) etc. **[unverified — copy them from the published
IDTA-02008 template AASX, do not type them from memory]**. The spec leaves the query language and the
response format of the linked endpoint open, so our `/packages/{id}/values` JSON is acceptable as long as
the Description states the format (`{result:[{time, value, ...}]}`, time basis = source vs received).

Caveats:
- KOSMO policy `iriConflict=KOSMO first` would rewrite the IDTA semanticIds to our IRI root. For
  TimeSeries (like AID) set `standardTemplateSemantics=preserve`, or keep TimeSeries out of the KOSMO
  submission file and add it only to the integration variant. Check KOSMO's required-submodel count range.
- The values route is outside Part 2 and needs the same auth as the repository (API key); say so in
  the segment Description, because Endpoint alone suggests anonymous access.
- `basis=received` vs source timestamp must be stated; MES/CMMS analytics will otherwise mix them.

## 5. semanticIds I am confident about (others: take from the official template AASX)

| Item | semanticId | Confidence |
|---|---|---|
| Digital Nameplate V2.0 submodel | `https://admin-shell.io/idta/nameplate/2/0/Nameplate` | high |
| Digital Nameplate V3.0 submodel | `https://admin-shell.io/idta/nameplate/3/0/Nameplate` | high |
| Contact Information (02002) submodel | `https://admin-shell.io/zvei/nameplate/1/0/ContactInformations` | high |
| Hierarchical Structures 1.0 submodel | `https://admin-shell.io/idta/HierarchicalStructures/1/0/Submodel` | high (1.1: [unverified]) |
| Asset Interfaces Description 1.0 submodel | `https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel` | high (1.1 id: [unverified]) |
| Time Series Data 1.1 submodel | `https://admin-shell.io/idta/TimeSeries/1/1` | high |
| Handover Documentation 2.0 submodel | `0173-1#01-AHF578#001` (IRDI) | medium [unverified] |
| Event payload / BasicEventElement / webhook types | **none exist as IDTA IRIs** — use our own IRI root and say so | — |

For event `type` values and our MQTT topics, do **not** attach an IDTA-looking IRI; a fabricated
`admin-shell.io` IRI is worse than none because integrators will trust it.

## 6. Prioritised list

**Must**
1. Fix `/lookup/shells` name matching (globalAssetId only matches globalAssetId; missing name → 400).
2. Publish the specificAssetId naming convention (§3.1) with `externalSubjectId` per system; keep globalAssetId for KOSMO.
3. Define the event payload (§2.1) referencing aasId, submodelId, idShortPath, semanticId, ModelReference keys; "notify then fetch".
4. Advertise satisfied read profiles in `/description`; configure a public base URL for descriptor hrefs.

**Should**
5. TimeSeries submodel with LinkedSegment → values API (§4), template IRIs copied from the official AASX.
6. Discovery `POST/DELETE /lookup/shells/{aasId}` writing into the AAS specificAssetIds (single source of truth).
7. Model change events (submodel/element created/updated/deleted) in addition to value events — integrators need to know when mappings break.

**Later**
8. Operation invoke (async first) — only with an explicit safety design.
9. Registry / submodel-registry write operations — only for a central multi-repository registry.
10. BasicEventElement declarations in a non-submitted integration submodel, once validator acceptance is checked; revisit when IDTA publishes a normative eventing spec.
