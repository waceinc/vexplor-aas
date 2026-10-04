# VEXPLOR AAS Studio

**Author, validate, serve and collect live values for AAS (Asset Administration Shell) — in one web app.**
Upload one machine's AASX, see exactly which rules it breaks, and fix what can be fixed in one step.

This used to take three tools. VEXPLOR AAS Studio brings the work together and is built so that
**people new to AAS** can follow along.

| Task | Usual tool | Here |
|---|---|---|
| Open · edit · export AASX | AASX Package Explorer (desktop) | In the browser, with findings and auto-fix |
| Serve AAS to other systems (Part 2 REST · registry) | Eclipse BaSyx server | The same server does it |
| Collect machine values · publish them by subscription | Separate OPC UA client/server | Collects per the AID in the AAS and publishes via an OPC UA server |

> Not affiliated with, and not derived from, the tools above — it combines the same jobs in one place.

**New here?** Click **"Start with a sample"** on the start screen to open a fully filled equipment file and a process structure.

[한국어](README.md) · [Manual (Korean)](docs/사용법.md) · [Install (Korean)](docs/설치.md) · [The 43 rules (Korean)](docs/규칙_목록.md)

> The documentation is written in Korean. The user interface is available in English
> (Settings → Language). Text produced by the server — finding messages, rule descriptions and
> the validation report — is still Korean.

---

## Why

An AASX file can pass every standard check and still be **rejected by the validator of the body
you submit it to.**

Passing the AAS metamodel constraints (aas-core), the official JSON schema and a BaSyx import does
not help when the receiving side enforces its own business rules — an allow-list of semantic IDs,
mandatory submodels, package-structure requirements. Those rules are not in the standard, so you
learn about them by failing.

This tool implements such rules as a linter and reports them **before** submission. Where the
standard and the receiving validator disagree, it does not silently pick a side: the conflict is
exposed as a policy the user decides.

> The receiving validator remains the only authority on acceptance. This tool is a pre-check.

## What it does

| | |
|---|---|
| **Open & edit** | Load AASX (JSON or XML), browse it as a tree, edit values, elements, submodels and concept descriptions |
| **Lint** | [43 rules](docs/규칙_목록.md) in three layers — package structure (L1), metamodel constraints (L2), submission business rules (L3) |
| **Quick fix** | Preview the fixable findings, choose, apply at once. Every relocation is recorded |
| **Report** | A printable HTML validation report |
| **Undo & history** | One-step undo, and restore a submodel to an earlier point |
| **Process bundles** | Group several machines into a process and export a submission bundle |
| **Data collection** | Read live values from OPC UA devices, addressed by the AID submodel inside the AAS |
| **Standard API** | IDTA Part 2 REST API, so other systems can read the AAS held here |
| **Accounts** | Admin / editor / viewer, with an audit trail of who changed what |

## Quick start

### Docker

```bash
git clone <this repository> && cd <folder>
cp .env.example .env          # only POSTGRES_PASSWORD is required
docker compose up -d --build
```

Open `http://localhost:8080`.

### From source — Node.js 22+

```bash
npm install
npx tsc -b
npm run build --workspace apps/web
node apps/api/dist/server.js     # http://localhost:8080
```

With no configuration the server binds to **127.0.0.1 only**. To share it, configure accounts or
an API key first.

> 🔴 **Create the first administrator right after starting** (Settings → Create first admin). Once any
> account exists, both the UI and the API require a login (or an API key). Until then the server is open.

## Layout

A TypeScript monorepo.

| Package | Role |
|---|---|
| `packages/aas-core` | AAS V3.0 metamodel types |
| `packages/aasx` | AASX (OPC package) reader/writer with lossless round-trip |
| `packages/linter` | Rules, quick fixes, reports |
| `packages/store` | Storage port — in-memory, folder and PostgreSQL pass the same conformance suite |
| `packages/collector` | Resolves AID and collects field values |
| `packages/opcua` | OPC UA client and server ([node-opcua](https://github.com/node-opcua/node-opcua)) |
| `apps/api` | REST API server |
| `apps/web` | React front end |

## Standards

| Standard | Status |
|---|---|
| AAS metamodel **V3.0** (IDTA-01001-3-0) | Pinned. Not auto-upgraded to 3.1 |
| AASX package (IDTA-01005) | Reads JSON and XML, writes JSON |
| **Part 2 REST API** (IDTA-01002-3-0) | AasxFileServer 6/6 · ConceptDescription 7/7 · AAS Repository 47/54 · Submodel Repository 38/45 · partial Registry and Discovery |
| AID 1.1 (IDTA-02017) | OPC UA address resolution |

`node scripts/part2-coverage.mjs` compares the implementation against the specification's OpenAPI
files and prints the exact coverage.

## Things to know

- **Authentication is opt-in.** With neither accounts nor an API key the server only listens on
  the local machine.
- **The OPC UA server port (4840) has no authentication.** It is off by default; if you enable it,
  keep it inside a trusted network.
- Once people sign in, **put HTTPS in front** — see [`Caddyfile.example`](Caddyfile.example).
- Report security problems through the channel in [SECURITY.md](SECURITY.md), not a public issue.

## Contributing

```bash
bash scripts/ci.sh      # build → typecheck → tests → spec coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE).

Copyright 2026 WACE. The names and logos "VEXPLOR" and "WACE" are trademarks of WACE and are not licensed for use — see
[NOTICE](NOTICE). Dependencies are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
`docs/spec/part2/` contains the specification published by the IDTA under CC BY 4.0.
