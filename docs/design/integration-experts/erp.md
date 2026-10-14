# VEXPLOR AAS Studio — ERP integration: expert opinion

Reviewer role: senior ERP integration consultant (SAP S/4HANA & B1 PM/MM/AA, Douzone iCube/Amaranth, Younglimwon K-System, mid-size Korean manufacturers).
Scope read: `README.md`, `docs/usage.md` §4–§7, §12; `apps/api/src/routes/part2.ts`, `registry.ts`, `packages.ts` (CSV table export); `packages/linter/src/docs/table.ts`; `packages/linter/src/rules/l2-constraints.ts` (specificAssetIds); the sample `apps/web/public/samples/RollFormingMachine_sample.aasx` (unzipped `aasx/data.json`, all paths below are taken from it).
No repository file was edited.

---

## 0. Bottom line

The tool already holds the right *engineering* master data (nameplate, BOM tree, documents, maintenance plan) and already has the two primitives an integration needs: **optimistic-locked revisions with ETag** (`part2.ts` `withEtag`/`If-Match`) and **discovery by asset ID** (`registry.ts` `GET /api/v3.0/lookup/shells?assetIds=…`). What is missing is not more AAS — it is a **flat, stable, ERP-shaped projection** of that data, a **place to keep the ERP's own keys**, and a **change feed**. ERPs at mid-size Korean plants do not consume AAS JSON; they consume CSV/Excel uploads (iCube, K-System, SAP B1 DTW/LSMW-style loads) or a plain JSON REST call from a middleware script. Build those three things, keep the tool on the *engineering* side of the line (no cost, no valuation, no posting), and ERP integration becomes a configuration task instead of a project.

Priority summary:

| # | Item | Priority |
|---|---|---|
| 1 | Neutral equipment-master export (CSV + JSON) with fixed column keys and a schema version | MUST |
| 2 | External-references map per asset (system → id), stored outside the AASX by default, optionally projected to `specificAssetIds` | MUST |
| 3 | Instance discipline: an ERP row is a physical unit (`assetKind: Instance`, serial number), never a Type file | MUST |
| 4 | BOM export as parent–child rows (flattened `HierarchicalStructures`) | MUST |
| 5 | Document-index export (no binaries) from `HandoverDocumentation` | SHOULD |
| 6 | External-reference import (ERP sends back asset no., plant, cost center) — CSV + REST, writes only the sidecar map | MUST |
| 7 | Pull change feed (`GET /changes?since=<cursor>`) built on the existing history/revision table | SHOULD |
| 8 | Maintenance-plan export (task list, intervals, durations, tools, consumables IDs) for PM/EAM | SHOULD |
| 9 | Operating counters export (run hours, cumulative energy) as *measurement documents* | LATER |
| 10 | Push webhooks (HMAC-signed, at-least-once) | LATER |
| 11 | ERP-specific adapters (SAP OData, iCube/Amaranth API) | LATER, outside core repo |

---

## 1. What the sample file actually contains (facts that drive the design)

- `assetAdministrationShells[0].assetInformation` = `{ assetKind: "Type", globalAssetId: "https://www.smart-factory.kr/ids/asset/RollFormingMachine/1/0" }` — **no `specificAssetIds`**, and it is a **Type**, yet `DigitalNameplate.SerialNumber = "EXM-RFL-2026-00127"` is filled. An ERP equipment record (SAP PM `EQUI`, iCube 설비대장, K-System 설비마스터) is always one physical unit. A Type file carrying a serial number is ambiguous for an ERP join. See §3.
- `HierarchicalStructures` entry node `RollFormingMachine` has `globalAssetId = …/asset/RollFormingLine/1/0`, while the shell's own `globalAssetId` is `…/asset/RollFormingMachine/1/0`. **The BOM root does not point to the shell's own asset.** For an ERP BOM join (header material = this machine) that is a broken key. Recommend a lint rule (see §8, test E-7) — the existing HIER-2 checks child targets, not root = self.
- `SubmodelElementList` children have no `idShort` (correct per AAS V3.0). Therefore any path-based column key must use the list index or, better, a business key inside the item (`DocumentIdentifier`, `ToolID`, `ConsumableID`, `MaintenanceID`). **Never key ERP columns on list indexes** — reordering in the editor would silently re-map rows.
- `BulkCount` (quantity) lives on the Entity (`HierarchicalStructures.RollFormingMachine.RollStandUnit.BulkCount = 12`); part entities carry `globalAssetId` but no material number. Material numbers must come from the external-reference map (§4).

---

## 2. Field-level mapping (ERP object ↔ AAS path in the sample)

Path notation: `Submodel.idShort/…`; `[]` = a SubmodelElementList item (no idShort), keyed by the business key named in the "row key" column.

### 2.1 Equipment / fixed-asset master (one row per physical unit)

| Neutral key (stable) | AAS source path (sample) | Sample value | SAP PM `EQUI`/`EQKT` field [names I am sure of] | iCube / K-System equivalent | Notes |
|---|---|---|---|---|---|
| `aasId` | `assetAdministrationShells[].id` | `https://www.smart-factory.kr/ids/aas/RollFormingMachine/1/0` | — (store as external key / classification char.) | 비고/외부키 칸 | Tool-side primary key |
| `globalAssetId` | `assetInformation.globalAssetId` | `…/ids/asset/RollFormingMachine/1/0` | — | — | Join key for group files and discovery |
| `assetKind` | `assetInformation.assetKind` | `Type` | — | — | Export only `Instance` rows by default |
| `manufacturer` | `DigitalNameplate/ManufacturerName` (MLP) | `Example Manufacturer Co., Ltd.` | `HERST` (manufacturer) | 제조사 | MLP → choose language by export option, default `ko` then `en` |
| `productDesignation` | `DigitalNameplate/ManufacturerProductDesignation` (MLP) | `Roll Forming Line - Automotive Body` | `EQKTX` (description, 40 chars) | 설비명 | Truncation rule must be explicit (see §5) |
| `productFamily` | `DigitalNameplate/ManufacturerProductFamily` (MLP) | `Automotive Body RFL` | — | 설비분류(참고) | |
| `modelNumber` | `DigitalNameplate/ManufacturerProductType` | `RF-AUTO-BODY-12ST` | `TYPBZ` (model number) | 모델명/규격 | |
| `orderCode` | `TechnicalData/GeneralInformation/ManufacturerOrderCode` | `RF-AUTO-BODY-12ST` | `MAPAR` (manufacturer part no.) [unverified field name] | 제조사품번 | |
| `serialNumber` | `DigitalNameplate/SerialNumber` | `EXM-RFL-2026-00127` | `SERGE` (manufacturer serial no.) | 제조번호 | Mandatory for Instance export |
| `yearOfConstruction` | `DigitalNameplate/YearOfConstruction` | `2026` | `BAUJJ` | 제조년도 | |
| `dateOfManufacture` | `DigitalNameplate/DateOfManufacture` | `2026-03-18` | `BAUMM` holds month only [unverified]; keep full date in neutral file | 제조일자 | ISO 8601 date, no time |
| `productUri` | `DigitalNameplate/URIOfTheProduct` | `https://www.smart-factory.kr/ids/asset/R…` | — | — | |
| `markings` | `DigitalNameplate/Markings[]/MarkingName` (joined `;`) | `CE 2006/42/EC, KCs S-인증, KOSHA M-29 …` | classification characteristic | 인증정보 | Multi-value → separate CSV or `;`-joined, documented |
| `weightKg` | `TechnicalData/TechnicalPropertyAreas[]/GeneralEquipmentSpecification/DimensionSpec/TotalWeight` | `8500.0` | `BRGEW` + `GEWEI` (gross weight + unit) | 중량 | Unit comes from the ConceptDescription, not the column name |
| `ratedPowerKw` | `…/DriveMotorSpecification/MotorRating/RatedMotorPower` | `30.0` | classification characteristic | 정격출력 | Type-level spec; optional |
| `location.company` | group file AAS idShort (e.g. `SampleFactory`) | — | `SWERK`/`IWERK` (plant) — **ERP-owned** | 사업장 | Tool exports its own name; plant code comes back from ERP (§4) |
| `location.line` | group file `HierarchicalStructures` Line entity | — | functional location `TPLNR` — **ERP-owned** | 라인 | |
| `location.process` | group file process Entity idShort (e.g. `PressLine`) | — | functional location / `ARBPL` work center — **ERP-owned** | 공정 | |
| `revision` | store revision (ETag) of the shell | — | — | — | For idempotent import (§5) |
| `exportedAt` | export time | — | — | — | |

Fixed-asset (SAP AA `ANLA`, iCube 고정자산): the tool contributes **only** descriptive keys (`serialNumber`, `manufacturer`, `modelNumber`, `yearOfConstruction`, `location.*`). Acquisition value, capitalization date, depreciation key, useful life and cost center are ERP-owned and must never be exported or stored as authoritative by this tool (§7).

### 2.2 BOM (`HierarchicalStructures`, IDTA 02011)

Flatten each `HasPart` relation into one row. Sample rows:

| `parentPath` | `childPath` | `childGlobalAssetId` | `quantity` | `level` | `entityType` |
|---|---|---|---|---|---|
| `RollFormingMachine` | `RollFormingMachine/Uncoiler` | `…/asset/Uncoiler/1/0` | 1 | 1 | SelfManagedEntity |
| `RollFormingMachine` | `RollFormingMachine/RollStandUnit` | (from entity) | **12** (`BulkCount`) | 1 | SelfManagedEntity |
| `RollFormingMachine/RollStandUnit` | `…/RollStandUnit/FormingRoll` | (from entity) | 1 | 2 | SelfManagedEntity |
| `RollFormingMachine/RollStandUnit` | `…/RollStandUnit/DriveMotor` | (from entity) | 1 | 2 | SelfManagedEntity |
| `RollFormingMachine` | `RollFormingMachine/CutOffPress` | (from entity) | 1 | 1 | SelfManagedEntity |

Source elements: `HierarchicalStructures/RollFormingMachine` (EntryNode), child `Entity`s, `HasPart_*` `RelationshipElement` (`first`/`second` ModelReferences), `BulkCount` Property, `ArcheType = Full`.

ERP mapping:
- `parentPath` root ↔ SAP equipment BOM header (`EQUI` + BOM usage 4 "plant maintenance") or material BOM `STKO`/`STPO` [object names sure; load method varies]; iCube/K-System 설비 BOM 또는 예비품 BOM.
- `childGlobalAssetId` → **material number via external-reference map** (§4). If no ERP material number is mapped, the row is exported with `erpMaterial` empty and flagged `unmapped`; it is not dropped.
- `quantity`: rule — `BulkCount` on the child entity, default 1. Quantity semantics is "per parent", not cumulative; say so in the header comment.
- `×n` vs per-unit (usage.md §7-5): group-file `×n` rows are **not** equipment rows for ERP; only per-unit files (`name_1…name_n`) are.

### 2.3 Documents (`HandoverDocumentation`, VDI 2770 based)

One row per `Documents[] × DocumentVersions[]`:

| Neutral key | AAS path | Sample |
|---|---|---|
| `documentId` (row key) | `Documents[]/DocumentIds[]/DocumentIdentifier` where `DocumentIsPrimary=true` | `DOC-03-01-0001` |
| `documentDomainId` | `…/DocumentIds[]/DocumentDomainId` | `03` |
| `classId` | `Documents[]/DocumentClassifications[]/ClassId` | `03-01` |
| `className` | `…/ClassName` (MLP) | `설치 매뉴얼 (Install Manual)` |
| `classificationSystem` | `…/ClassificationSystem` | `VDI2770:2020` |
| `version` | `Documents[]/DocumentVersions[]/Version` | `V1.0` |
| `language` | `…/Language` | `ko` |
| `title` | `…/Title` (MLP) | `롤 스탠드 설치 매뉴얼` |
| `status` / `statusDate` | `…/StatusValue`, `…/StatusSetDate` | `Released`, `2026-04-01` |
| `issuer` | `…/OrganizationOfficialName` | `Example Machinery Inc.` |
| `fileName` | `…/DigitalFiles[]` (File value) | `file:///EXM_RFL_InstallManual_V1.0.pdf` |
| `fileUrl` | Part 2 attachment URL built by the tool | — |
| `sha256` | computed at export | — |

ERP mapping: SAP DMS (`DRAW`: document type/number/part/version) [object sure, load path unverified for B1]; iCube/Amaranth 전자결재·문서관리 첨부, K-System 설비대장 첨부. Most mid-size ERPs only want **title + link + version**, not the binary. Export an index with URLs; ship binaries only in the existing reference bundle ZIP.

### 2.4 Maintenance plan (`MaintenanceInstructions`) — for PM/EAM, no costs

| Neutral key | AAS path (sample) | Sample |
|---|---|---|
| `taskId` (row key) | `MaintenanceInstructionsForSpecificInterval_0/BasicMaintenanceInformation/MaintenanceID` | `MI-RollForming-01` |
| `taskName` | `…/NameOfMaintenance` (MLP) | `롤 교체 및 정렬 작업` |
| `source` | `…/SourceOfMaintenanceInstructions` | `롤포밍기 제조사 유지보수 매뉴얼 …` |
| `safety` | `…/SafetyRegulationsToBeObserved` | `KOSHA GUIDE M-29-2020, ISO 12100` |
| `technicians` | `…/MaintenanceTechnicians/NumberOfRequiredTechnicians` | `1.0` |
| `qualification` | `…/MaintenanceTechnicians/RequiredQualification` | `산업안전보건법 정비 자격자` |
| `stepId` (child row key) | `…/ListMaintenanceSteps/MaintenanceStep_n/MaintenanceStepID` | `RollStep01` |
| `stepName` / `instruction` | `…/MaintenanceStepName`, `…/InstructionMaintenanceStep` | `롤 마모 상태 점검` |
| `durationValue` + `durationUnit` | `…/EstimatedDurationTimeMaintenanceStep/ValueEstimatedDurationTimeMaintenanceStep`, `…/UnitEstimatedDurationTimeMaintenanceStep` | `15.0` `min` |
| `toolIds` | `MaintenanceToolList[]/ToolID` via `ToolsForMaintenanceStep` ReferenceElement | `TOOL-01` |
| `consumableIds` | `MaintenanceConsumablesList[]/ConsumableID` via `ConsumablesForMaintenanceStep` | `CONS-01` |
| `signatureRequired` | `…/DocumentationSignatureMandatory` | `true` |

ERP mapping: SAP PM task list operations (`PLKO`/`PLPO`) [object names sure]; durations → operation work/duration; `consumableIds` → component material via external-reference map. **The interval itself (e.g. every 500 h) is not in the sample** — the submodel idShort says "ForSpecificInterval" but no interval value exists. Do not invent one; export empty and flag.

**Maintenance-cost hooks** — the only legitimate hooks the tool can offer are *quantities that an ERP prices*: labour duration × technicians, consumable IDs × quantity, and counters (`OperationalData/MaintenanceMonitoring/MaintenanceState/CumulativeRunHours = 5200.0`, `OperationalData/EnergyMonitoring/PowerMeasurement/CumulativeEnergy = 45600.0`). Price, rate and cost-center assignment stay in the ERP.

### 2.5 Location (company / line / process)

Comes from the group file (`docs/usage.md` §7): company AAS → Line Entity (`…/cd/Line/1/0`) → process Entity → equipment Entity whose `globalAssetId` points at the equipment file. Export as path strings (`SampleFactory/PressLine/RollFormingMachine_1`) plus each level's `globalAssetId`. ERP codes (plant `WERKS`, functional location `TPLNR`, work center) are **received**, never derived from names.

---

## 3. Instance discipline (MUST, prerequisite)

1. ERP export of equipment master includes only shells with `assetKind = Instance` by default; Type rows only with an explicit `--include-types` flag and a `assetKind` column.
2. A Type file with a filled `SerialNumber` produces a linter **warning** ("serial number on a Type — split into a unit file before ERP export"). The sample file triggers this.
3. Per-unit files from §7-5 ("per unit") are the natural ERP rows; their `derivation` link (type → unit, `routes/derivation.ts`) gives `typeAasId` as an extra column so the ERP can group units by model.
4. BOM root entity `globalAssetId` must equal the shell's `assetInformation.globalAssetId` for ERP export; mismatch (as in the sample) blocks BOM export with a clear message, not a silent wrong header.

---

## 4. External references — what the ERP sends back and how to store it (MUST)

### 4.1 What comes back

| From ERP | Example | Used for |
|---|---|---|
| Equipment / asset number | SAP `EQUNR` `10004711`; SAP AA `ANLN1`+`ANLN2`; iCube 설비코드 | Join key for every later sync |
| Company code / plant | `BUKRS`, `WERKS`; iCube 회사코드·사업장코드 | Scoping |
| Functional location / work center | `TPLNR`, `ARBPL` | Location |
| Cost center | `KOSTL` | **Display only, read-only, never edited in the tool** |
| Material number per BOM child / consumable | `MATNR`; iCube 품목코드 | BOM and maintenance consumables |
| ERP-side last change timestamp | — | Conflict detection |

### 4.2 Storage model

A sidecar, per package and per `globalAssetId` (and per BOM child `globalAssetId` / consumable `ConsumableID`):

```jsonc
// GET/PUT /packages/:packageId/external-refs   (tool-specific, not Part 2)
{
  "schema": "vexplor.externalRefs/1",
  "subjects": [
    {
      "subject": { "kind": "asset", "globalAssetId": "https://…/asset/RollFormingMachine_1/1/0" },
      "refs": [
        { "system": "sap-s4:PRD:100", "type": "equipment",     "id": "10004711", "syncedAt": "2026-10-14T09:00:00+09:00", "source": "import:csv" },
        { "system": "sap-s4:PRD:100", "type": "plant",         "id": "1000" },
        { "system": "sap-s4:PRD:100", "type": "costCenter",    "id": "4711", "readOnly": true },
        { "system": "icube:WACE",     "type": "equipmentCode", "id": "EQ-0127" }
      ]
    },
    { "subject": { "kind": "consumable", "globalAssetId": "https://…/asset/RollFormingMachine_1/1/0", "key": "CONS-01" },
      "refs": [ { "system": "sap-s4:PRD:100", "type": "material", "id": "MAT-ROLL-150" } ] }
  ]
}
```

Rules:
- `system` is a free string but **must** include the client/tenant (`sap-s4:<SID>:<client>`, `icube:<company>`). The same equipment number means different things in two clients.
- Uniqueness: (`system`, `type`, `id`) → exactly one subject. Enforce in the store; a second claim is a 409 with both subjects listed (mirrors the existing `/registry-conflicts` idea).
- Stored **outside the AASX by default** (like the derivation snapshot in usage.md §7-5, "kept next to the file and not exported"). Reason: ERP numbers and especially cost centers are internal data; an AASX is handed to suppliers, KTL and customers.
- Optional projection: per `system`, a flag `publishAsSpecificAssetId: true` writes `{ name: "<system>:<type>", value: id }` into `assetInformation.specificAssetIds` (with `externalSubjectId` = the ERP owner's global reference — the existing L2 constraint at `l2-constraints.ts:626` already checks `externalSubjectId` shape). Benefit: the **existing** `GET /api/v3.0/lookup/shells?assetIds=…` then finds a shell by SAP equipment number with no new code. Never project `costCenter`.
- Store keeps history of ref changes with actor (reuse `packages/store/src/actor.ts`).

---

## 5. Interchange formats

What mid-size Korean ERPs realistically accept from a satellite tool, in order of how often I see it working:

1. **CSV / Excel upload with fixed column order and Korean or code headers** — iCube, Amaranth, K-System and SAP B1 all have an upload screen or import template. This is the 80 % path. [SAP B1 DTW uses its own CSV templates — field names are template-specific, verify per version.]
2. **JSON over REST pulled by a middleware script** (Python/PowerShell scheduled job, or an RPA/ETL tool) that then calls the ERP's own interface.
3. SAP-native: **OData services / BAPIs** (e.g. equipment create via `BAPI_EQUI_CREATE` [I am confident this BAPI exists; exact parameters unverified]) and IDoc. These belong in an adapter maintained by the SAP integrator, not in this repo. **Do not implement IDoc or SAP OData in core.**

### 5.1 Neutral equipment-master JSON (schema `vexplor.equipmentMaster/1`)

```jsonc
{
  "schema": "vexplor.equipmentMaster/1",
  "exportedAt": "2026-10-14T09:00:00+09:00",
  "source": { "tool": "VEXPLOR AAS Studio", "version": "x.y.z", "packageId": "pkg_1" },
  "language": "ko",
  "items": [
    {
      "key": "https://…/asset/RollFormingMachine_1/1/0",   // = globalAssetId, the stable row key
      "aasId": "https://…/aas/RollFormingMachine_1/1/0",
      "assetKind": "Instance",
      "typeAasId": "https://…/aas/RollFormingMachine/1/0",
      "revision": 42,
      "nameplate": {
        "manufacturer": "Example Manufacturer Co., Ltd.",
        "productDesignation": "Roll Forming Line - Automotive Body",
        "productFamily": "Automotive Body RFL",
        "modelNumber": "RF-AUTO-BODY-12ST",
        "orderCode": "RF-AUTO-BODY-12ST",
        "serialNumber": "EXM-RFL-2026-00127",
        "yearOfConstruction": "2026",
        "dateOfManufacture": "2026-03-18",
        "productUri": "https://…",
        "markings": ["CE 2006/42/EC", "KCs S-인증", "KOSHA M-29"]
      },
      "physical": { "weight": { "value": 8500.0, "unit": "kg" } },
      "location": { "path": ["SampleFactory", "PressLine"], "globalAssetIds": ["…", "…"] },
      "externalRefs": [ { "system": "sap-s4:PRD:100", "type": "equipment", "id": "10004711" } ],
      "sourcePaths": { "nameplate.serialNumber": "DigitalNameplate/SerialNumber" },
      "missing": ["nameplate.productUri"]
    }
  ]
}
```

- Units come from the ConceptDescription (IEC 61360 `unit`), never from the column name; if the CD has no unit, `unit: null` and the item appears in `missing`.
- `sourcePaths` is optional (`?trace=1`) — it lets an integrator audit every value back to the AAS path.
- `missing` lists empty required keys instead of guessing values (consistent with the "no made-up values" rule in `table.ts`).

### 5.2 CSV form (same keys, flattened)

- Header row = neutral keys, dot-separated: `key,aasId,assetKind,typeAasId,revision,nameplate.manufacturer,…,location.path,ext.sap-s4:PRD:100.equipment`.
- Second option `?headers=ko` gives Korean labels for upload screens, but the **key header is the contract**; Korean labels may change between versions, keys may not.
- First line optional comment `#schema=vexplor.equipmentMaster/1` behind `?meta=1` (some ERP uploaders choke on comment lines — default off).
- Encoding: **UTF-8 with BOM** option (`?bom=1`) because Excel-based Korean upload flows still mis-read BOM-less UTF-8; CP949 option is a frequent request but is lossy — offer only if asked, and refuse rows containing characters outside CP949 rather than substituting.
- RFC 4180 quoting, CRLF line endings, `.` decimal separator, ISO dates, booleans `true/false`, multi-values `;`-joined with `;` escaped. Reuse the existing `csvCell` from `packages/linter/src/csv.ts`.
- Field-length profile `?profile=sap-pm` only *reports* overlong values (e.g. description > 40 chars) in a `warnings` column; it never truncates silently.
- Sibling files with the same conventions: `bom.csv` (§2.2), `documents.csv` (§2.3), `maintenance-tasks.csv` + `maintenance-steps.csv` (§2.4).

### 5.3 Endpoints (tool-specific, beside Part 2 — do not overload Part 2 routes)

| Method | Path | Purpose |
|---|---|---|
| GET | `/packages/:id/erp/equipment?format=json\|csv` | single file |
| GET | `/erp/equipment?format=…&group=<groupPackageId>` | all units under a group file (with location) |
| GET | `/erp/bom?root=<globalAssetId>&format=…` | BOM rows |
| GET | `/erp/documents?…` | document index |
| GET | `/erp/maintenance?…` | tasks + steps |
| GET/PUT | `/packages/:id/external-refs` | read / replace refs (If-Match revision) |
| POST | `/erp/external-refs:import?dryRun=1` | bulk CSV/JSON import; dry-run returns the diff like the existing "Fill from CSV" preview |
| GET | `/erp/changes?since=<cursor>&limit=` | change feed (§6) |

Auth: existing API keys (`AAS_TOKEN`, usage.md §12). Export = Viewer role; external-refs import = Editor; a separate "integration" key scope would be better than reusing a human editor role [design suggestion].

---

## 6. Change notification and delivery semantics

### 6.1 What an ERP cares about (emit these, nothing else)

| Event | Trigger | Why ERP cares |
|---|---|---|
| `equipment.created` | new Instance shell | create equipment / 설비 등록 |
| `equipment.updated` | change in any mapped nameplate key, weight, location | update master; carry `changedKeys[]` |
| `equipment.retired` | package deleted or shell set inactive | ERP sets deletion flag — **ERP decides**, the tool only informs |
| `bom.changed` | HasPart added/removed, BulkCount changed, child globalAssetId changed | spare-parts BOM |
| `document.released` / `document.superseded` | `StatusValue` → `Released`, new `Version` | DMS link update |
| `maintenance.planChanged` | task / step / duration / consumable change | task list review |
| `externalRef.conflict` | uniqueness violation | needs human |

Not emitted: OperationalData live values (that is a historian/MES stream, not ERP master), linter findings, attachments-only edits without document metadata change, thumbnail changes.

### 6.2 Semantics

- **Pull first (SHOULD):** `GET /erp/changes?since=<opaque cursor>` returning ordered events from the existing history table (`identifiable_history` in `postgres.ts`; folder store `model.json` history). Each event: `eventId` (UUID), `cursor` (monotonic), `type`, `subject.globalAssetId`, `revision` (= ETag), `changedKeys`, `occurredAt`, `actor`. The consumer stores the last cursor. This is at-least-once by construction and needs no new dependency.
- Events are **state notifications, not deltas**: the consumer re-reads the current projection (`/erp/equipment?key=…`) for that subject. This removes ordering bugs when events are replayed.
- Idempotency: consumers dedupe on `eventId`; projection reads carry `revision` so a stale event (revision < already applied) is ignored.
- Coalescing: several edits within N seconds to the same subject may emit one event with merged `changedKeys` — the editor autosaves per keystroke-batch, ERP should not get 30 events for typing a serial number.
- Retention: keep the feed ≥ 30 days; if `since` is older than retention, return 410 and the consumer must do a full export. Say so in docs.
- **Push (LATER):** webhooks with HMAC-SHA256 signature header over the raw body (Node `crypto`, no new dependency), retries with exponential backoff, dead-letter list visible to admins, same event body as the pull feed. At-least-once, no ordering guarantee across subjects.

---

## 7. What must NOT be done

1. **No cost, price, valuation or financial fields** in the AAS files or the tool's store as authoritative data: acquisition value, depreciation, useful life, capitalization date, labour rates, consumable prices, maintenance cost. ERP owns them. Cost center may be *displayed* from external refs (read-only), never edited or exported back.
2. **No writing into the ERP from the core tool** (no BAPI calls, no OData POST, no DB writes into iCube/K-System tables). The tool publishes; the ERP side (or its integrator's adapter) decides what to post. This keeps the tool's liability and the ERP's audit trail clean.
3. **No inventing values to fill a column**: empty stays empty and is listed in `missing`; no defaulting `yearOfConstruction` from `dateOfManufacture` without a declared rule, no unit guessing, no interval guessing for maintenance.
4. **No join on idShort, display name, list index or file name.** Join on `globalAssetId` or external ref only. idShort is renameable (usage.md §5) and list items have none.
5. **No ERP keys inside the exported AASX by default** (data leaves the company with the AASX). Projection to `specificAssetIds` only by explicit per-system opt-in, and never cost center.
6. **No exporting Type files as equipment**, and no exporting `×n` quantity rows as n pieces of equipment.
7. **No silent truncation or encoding substitution** (40-char SAP texts, CP949) — warn and let the integrator decide.
8. **No changing exported column keys without a schema version bump** (`vexplor.equipmentMaster/2`); keep v1 available for at least one release.
9. **No deleting ERP-linked assets without warning**: deleting a package whose asset has external refs should require confirmation and emit `equipment.retired`, mirroring the existing "group points to this file" warning (usage.md §7-6).
10. Live OperationalData is not ERP master data — do not push it into ERP equipment records.

---

## 8. Test plan — proving an ERP import will not break

All in vitest, using the existing sample `RollFormingMachine_sample.aasx` and pglite (already a devDependency).

**Contract / golden tests**
- E-1 Golden export: equipment JSON and CSV for the sample (after splitting into a unit) compared byte-for-byte to committed golden files. Any column change fails the build unless the schema version is bumped and a new golden is added.
- E-2 Column-key stability: a test asserts the header list of each CSV equals a frozen constant `EQUIPMENT_V1_COLUMNS`; reordering, renaming or removing fails. Adding columns is allowed only at the end.
- E-3 JSON schema: validate exported JSON against a committed JSON Schema (hand-written, validated with a minimal in-repo checker or existing Zod if present — no new heavy dependency).

**Round-trip / idempotency**
- E-4 Export → parse CSV back → equal to JSON export (same values, same types), including Korean text, commas, quotes, newlines inside MLP text, `;` in markings.
- E-5 Exporting twice without edits gives identical bytes except `exportedAt` (deterministic ordering by `key`, then business key).
- E-6 External-ref import is idempotent: importing the same CSV twice yields zero changes on the second dry-run.

**Data-quality gates**
- E-7 BOM root mismatch: the sample's entry node (`…/RollFormingLine/1/0`) ≠ shell asset (`…/RollFormingMachine/1/0`) → BOM export refuses with a specific error.
- E-8 Type with serial number → warning; Type excluded from default export.
- E-9 List reorder: move `Documents[]` items or `MaintenanceToolList[]` items in the editor → exported rows keyed by `DocumentIdentifier`/`ToolID` are unchanged.
- E-10 idShort rename of an Entity → BOM rows keep the same `childGlobalAssetId`; `childPath` change is reported as `bom.changed` but join key is stable.
- E-11 Units: `TotalWeight` unit comes from its CD; CD without unit → `unit: null` + listed in `missing`.
- E-12 MLP language fallback: `ko` missing → `en`; both missing → empty + `missing`.

**Encoding / ERP uploader quirks**
- E-13 UTF-8 BOM flag on/off; CRLF; RFC 4180 quoting of `"`; leading `=`/`+`/`-`/`@` cells escaped against CSV/formula injection when opened in Excel.
- E-14 SAP PM profile: 41-char description → warning column filled, value not truncated.

**External refs & concurrency**
- E-15 Uniqueness: two subjects claim (`sap-s4:PRD:100`, `equipment`, `10004711`) → 409 listing both.
- E-16 `PUT external-refs` with stale `If-Match` → 412 (reuse existing optimistic-locking pattern in `part2.ts`).
- E-17 Projection on: `GET /api/v3.0/lookup/shells?assetIds=<base64url {name:"sap-s4:PRD:100:equipment", value:"10004711"}>` returns the shell; projection off: returns nothing; cost center is never projected.
- E-18 AASX export does not contain external refs unless projection is on (unzip and grep).

**Change feed**
- E-19 Edit serial number → exactly one `equipment.updated` with `changedKeys=["nameplate.serialNumber"]` after coalescing window.
- E-20 Edit OperationalData live value or thumbnail → no event.
- E-21 Replay from cursor 0 twice → consumer dedupe by `eventId` gives the same final state; `since` older than retention → 410.
- E-22 Delete a package with external refs → confirmation required, then `equipment.retired`.

**Security / roles**
- E-23 Viewer key can export, cannot import refs (403); no key → 401 once accounts exist (as documented in usage.md §12).

---

## 9. Implementation notes for this codebase

- New code fits as one route module `apps/api/src/routes/erp.ts` + a pure projection module (e.g. `packages/aas-core/src/erp/` or a new small package) with functions `projectEquipment(env, ctx)`, `projectBom`, `projectDocuments`, `projectMaintenance`. Keep projection pure (Environment in, rows out) so tests need no server.
- Path resolution: reuse `resolveIdShortPath`/`locate` already in `part2.ts`; for list items resolve by business key, not index.
- Semantic-ID based lookup is more robust than idShort for standard templates (e.g. SerialNumber IRDI `0112/2///61987#ABA951#009`, ManufacturerName `0112/2///61987#ABA565#009`, YearOfConstruction `0112/2///61987#ABP000#002`, DocumentIdentifier `0173-1#02-AAO099#004` — all as found in the sample). Resolve by semanticId first, idShort second, and record which matched in `sourcePaths`.
- CSV: reuse `packages/linter/src/csv.ts` `csvCell`; the existing table CSV download (`packages.ts:1359`) shows the header/filename pattern.
- External refs storage: new table in `postgres.ts` / new JSON file in folder store, both behind the `AasStore` interface with the actor stamp.
- No new runtime dependencies are needed for anything in MUST/SHOULD.

---

## 10. Uncertainty register

- SAP field names marked above as sure: `EQUNR`, `HERST`, `TYPBZ`, `SERGE`, `BAUJJ`, `EQKTX`, `BRGEW`/`GEWEI`, `SWERK`/`IWERK`, `TPLNR`, `ARBPL`, `KOSTL`, `BUKRS`, `WERKS`, `MATNR`, `ANLN1`/`ANLN2`, tables `EQUI`/`EQKT`/`ANLA`/`STKO`/`STPO`/`PLKO`/`PLPO`/`DRAW`. Marked [unverified]: `MAPAR` as manufacturer part number on equipment, `BAUMM` semantics, BAPI parameter lists, B1 DTW template names.
- Douzone iCube/Amaranth and Younglimwon K-System: Korean labels given are typical screen names, not verified API field names — **[unverified]**; integrators should map from the neutral keys per installation.
- The IDTA 02011 HierarchicalStructures `BulkCount` semantics ("per parent") is taken from the sample and usage.md §6, not re-checked against the template text [unverified against spec wording].
