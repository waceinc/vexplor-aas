# Official metamodel examples — AAS V3.0 · V3.1 · V3.2

The `minimal` and `maximal` examples of every class, copied unchanged from the IDTA metamodel repository
<https://github.com/admin-shell-io/aas-specs-metamodel> (`schemas/json/examples/generated` and
`schemas/xml/examples/generated`), and each version's official JSON schema as `aas.schema.json`
(`schemas/json/aas.json`). The examples are generated test data (`something_…` values, a `John.Doe@example.org`
placeholder at the reserved example domain), not equipment data.

| Folder | Tag | Commit |
| --- | --- | --- |
| `3.0/` | `IDTA-01001-3-0-1_schemasV3.0.9` | `b11bbab79d9c2b47761ce878bee0ba592ee87513` |
| `3.1/` | `v3.1.2` | `a93e41c07c4018e864cba6016b760b9c7e0d849f` |
| `3.2/` | `v3.2.0` | `ecd191273a28dd9c4e7bb75e923f0f0fe5da444e` |

Used by `packages/aasx/test/metamodel-versions.test.ts` (XML and JSON of the same example read to the same model,
read → write in its own version loses nothing, lowering reports what it could not keep) and
`packages/aasx/test/metamodel-schemas.test.ts` (output written in any direction passes the target version's schema;
round trips between every pair of versions).

Licence: "Specification of the Asset Administration Shell, Part 1: Metamodel" examples, © Industrial Digital Twin
Association (IDTA), CC BY 4.0 (<https://creativecommons.org/licenses/by/4.0/>). Do not edit the files — refresh them
from a newer tag instead and update the table above.
