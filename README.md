**English** · [한국어](README.ko.md)

# VEXPLOR AAS Studio

**Author, validate, serve and collect live values for AAS (Asset Administration Shell) — in one web app.**
Upload one machine's AASX, see exactly which rules it breaks, and fix what can be fixed in one step.

![VEXPLOR AAS Studio — tree, summary and live collection on one screen](docs/images/manual/en/m02-layout.png)

This used to take three tools. VEXPLOR AAS Studio brings the work together and is built so that
**people new to AAS** can follow along.

| Task | Usual tool | Here |
|---|---|---|
| Open · edit · export AASX | AASX Package Explorer (desktop) | In the browser, with findings and auto-fix |
| Serve AAS to other systems (Part 2 REST · registry) | Eclipse BaSyx server | The same server does it |
| Collect machine values · publish them by subscription | Separate OPC UA client/server | Collects per the AID in the AAS and publishes via an OPC UA server |

> Not affiliated with, and not derived from, the tools above — it combines the same jobs in one place.

**New here?** Click **"Start with a sample"** on the start screen to open a fully filled equipment file and a process structure.

**Docs:** [Usage](docs/usage.md) · [Install](docs/install.md) · [Deployment & hosting](docs/deployment.md) · [The 43 rules](docs/rules.md)
— every document is also available in Korean.

---

## Why

An AASX file can pass every standard check and still be **rejected by the validator of the body
you submit it to.**

Passing the AAS metamodel constraints (aas-core), the official JSON schema and a BaSyx import does
not help when the receiving side enforces its own business rules — an allow-list of semantic IDs,
mandatory submodels, package-structure requirements. In Korea that receiving side is the KOSMO
Validator. Those rules are not in the standard, so you learn about them by failing.

This tool implements such rules as a linter and reports them **before** submission. Where the
standard and the receiving validator disagree, it does not silently pick a side: the conflict is
exposed as a policy the user decides.

> The receiving validator remains the only authority on acceptance. This tool is a pre-check.

## What it does

| | |
|---|---|
| **Open & edit** | Load AASX (JSON or XML), browse it as a tree, edit values, elements, submodels and concept descriptions. Fill many values at once from a submodel value table or from a CSV equipment list |
| **Lint** | [43 rules](docs/rules.md) in three layers — package structure (L1), metamodel constraints (L2), submission business rules (L3) |
| **Auto-fix** | Preview the fixable findings (19 rules), choose, apply at once. Every relocation is recorded |
| **Report** | A printable HTML validation report |
| **What to fill** | With the IDTA templates installed, every value row shows required · collected · optional, and "Show only what to fill" hides the rest |
| **Undo & history** | One-step undo, and restore a submodel to an earlier point |
| **Types and units** | Split a type file into units; when the type changes, review the differences line by line and pull only the lines you choose — values edited on site are never overwritten |
| **Process bundles** | Company → line → process → equipment → part. Group machines into a process and export a submission bundle |
| **Data collection** | Read live values from OPC UA · Modbus TCP · MQTT devices, addressed by the AID submodel inside the AAS. Each value shows whether it is live, stale or missing, and each machine gets a daily status bar (running · stopped · alarm). Add dozens of tags from one pattern |
| **Standard API** | IDTA Part 2 REST API, so other systems can read the AAS held here |
| **MES · ERP · CMMS integration** | A pull feed of every change and runtime event (CloudEvents), signed webhooks and MQTT, equipment / BOM / hierarchy / maintenance / document exports in JSON or CSV, ERP numbers kept next to the AASX, and server-side state, alarm, counter and threshold rules. A secure OPC UA server (accounts + encryption). See [docs/integration.md](docs/integration.md) |
| **Accounts** | Admin / editor / viewer, with an audit trail of who changed what |
| **English & Korean, light & dark** | The interface **and** everything the server writes — findings, rule descriptions, the validation report, bundle README, errors — come in English or Korean. If you never choose, the browser language decides (Korean browser → Korean, anything else → English). Light and dark themes |

## Quick start

### Docker

```bash
git clone <this repository> && cd <folder>
cp .env.example .env          # only POSTGRES_PASSWORD is required
docker compose up -d --build
```

Open `http://localhost:8080`. Details: [install.md](docs/install.md).

### From source — Node.js 24 LTS (22 or later works)

```bash
npm install
npx tsc -b
npm run build --workspace apps/web
node apps/api/dist/server.js     # http://localhost:8080
```

With no configuration the server binds to **127.0.0.1 only**. To share it, configure accounts or
an API key first — see [Usage §12](docs/usage.md).

> **Create the first administrator right after starting** (Settings → Create the first administrator). Once any
> account exists, both the UI and the API require a login (or an API key). Until then the server is open.

For development, run the UI separately:

```bash
npm run dev:api     # API on 8080
npm run dev:web     # UI on 5173 (in another terminal)
```

## Layout

A TypeScript monorepo — one language for the front end and the server.

| Package | Role |
|---|---|
| `packages/aas-core` | AAS V3.0 metamodel types · server-side text in English and Korean |
| `packages/aasx` | AASX (OPC package) reader/writer with lossless round-trip |
| `packages/linter` | Rules, auto-fixes, reports |
| `packages/store` | Storage — in-memory, folder and PostgreSQL pass the same conformance suite |
| `packages/collector` | Resolves AID and collects field values |
| `packages/opcua` | OPC UA client and server ([node-opcua](https://github.com/node-opcua/node-opcua)) |
| `packages/fieldbus` | Modbus TCP · MQTT collection adapters (no external dependencies — `node:net`) · test device and broker |
| `apps/api` | REST API server |
| `apps/web` | React front end |

### Using the libraries in another product

`@aas/core`, `@aas/aasx` and `@aas/linter` are attached to each GitHub release as npm tarballs
(`node scripts/pack-libraries.mjs`, checksums in `SHA256SUMS`). Install them **by release URL**:

```json
"@aas/aasx": "https://github.com/waceinc/vexplor-aas/releases/download/v2.1.0/aas-aasx-2.1.0.tgz"
```

Never by version number — the `@aas` scope on the public npm registry is not ours, so `"@aas/core": "^2.0.0"` would
install whatever someone else publishes there. The tarballs point at each other by release URL, so one pinned URL is
enough.

## Standards

| Standard | Status |
|---|---|
| AAS metamodel **V3.0** (IDTA-01001-3-0) | Pinned. Not auto-upgraded to 3.1 |
| AASX package (IDTA-01005) | Reads JSON and XML, writes JSON |
| **Part 2 REST API** (IDTA-01002-3-0) | AasxFileServer 6/6 · ConceptDescription 7/7 · AAS Repository 47/54 · Submodel Repository 38/45 · partial Registry and Discovery |
| AID 1.1 (IDTA-02017) | OPC UA · Modbus TCP · MQTT address resolution (Modbus · MQTT use the W3C WoT binding notation) |

`node scripts/part2-coverage.mjs` compares the implementation against the specification's OpenAPI
files and prints the exact coverage.

## Things to know

- **Authentication is opt-in.** With neither accounts nor an API key the server only listens on
  the local machine.
- **The OPC UA server (port 4840) requires an account and encryption** (Sign / SignAndEncrypt). It is off by default;
  `OPCUA_ALLOW_INSECURE=on` restores the old unauthenticated port for isolated test networks only.
- Once people sign in, **put HTTPS in front** — see [`Caddyfile.example`](Caddyfile.example).
- In English, what stays as it was written is what comes from your own files (names, values) and the
  folder names of the submission bundle, which the submission format fixes.
- Server startup logs are Korean by default; set `AAS_LANG=en` for English.
- Report security problems through the channel in [SECURITY.md](SECURITY.md), not a public issue.

## Contributing

```bash
bash scripts/ci.sh      # build → typecheck → tests → spec coverage → generated docs → licenses → i18n
```

CI runs on Node.js 22 and 24. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). You may modify it and ship it in commercial products.

Copyright 2026 WACE. The names and logos "VEXPLOR" and "WACE" are trademarks of WACE and are not licensed for use — see
[NOTICE](NOTICE). Dependencies are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
`docs/spec/part2/` contains the specification published by the IDTA under CC BY 4.0.
