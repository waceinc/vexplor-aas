# IDTA Part 2 (API) specification — copy

This folder keeps the original Part 2 API specification inside the repository so that our API can be
**checked against the specification automatically** — also in air-gapped networks and CI without internet access.

| File | Content |
|---|---|
| `part2-v3.0.4.yaml` | Shared schemas and query parameters (Message · Result · PagedResult · PackageDescription · Limit/Cursor/IdShort/SemanticId …) |
| `AssetAdministrationShellRepositoryServiceSpecification_V3.0_SSP-001.yaml` | `/shells` |
| `SubmodelRepositoryServiceSpecification_V3.0_SSP-001.yaml` | `/submodels` |
| `ConceptDescriptionServiceSpecification_V3.0_SSP-001.yaml` | `/concept-descriptions` |
| `AasxFileServer_V3.0_SSP-001.yaml` | `/packages` — **AASX file server interface** |
| `AssetAdministrationShellRegistryServiceSpecification_V3.0_SSP-001.yaml` | `/shell-descriptors` — **registry** |
| `SubmodelRegistryServiceSpecification_V3.0_SSP-001.yaml` | `/submodel-descriptors` |
| `DiscoveryServiceSpecification_V3.0_SSP-001.yaml` | `/lookup/shells` — **find an AAS by asset ID** |

- Source: <https://github.com/admin-shell-io/aas-specs-api> tag `v3.0.4`
  (the latest bug-fix release of the IDTA-01002-3-0 line; our metamodel is V3.0, so we use the 3.0 line, not 3.1)
- Publisher: Industrial Digital Twin Association (IDTA)
- License: **CC BY 4.0** — kept unmodified with attribution. Do not edit these files.

## How to check

```bash
node scripts/part2-coverage.mjs            # implemented / not implemented summary
node scripts/part2-coverage.mjs --all      # list everything not implemented
```

The script compares our route table (`@aas/api`) with the paths, methods and success status codes of the specification.
**It also reports paths we serve that the specification does not define** — using a standard path with a different
meaning makes Part 2 clients misbehave silently.
