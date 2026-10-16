# Sample integration bundle

Inputs and output of `buildBundle` (`@aas/bundle`), for a receiving product's import gate.

| File | What it is |
|---|---|
| `RollFormingMachine_Type.aasx` | Type — the anonymised roll forming machine (`tests/fixtures/01-roll-forming-machine.aasx`) |
| `RollFormingMachine_1.aasx`, `RollFormingMachine_2.aasx` | Two Instances made from the Type (own `globalAssetId`, serial number, BOM root, `derivedFrom` → the Type, so `typeAasId` links them) |
| `SampleFactory.aasx` | Company file: SampleFactory → PressLine → Forming → both units |
| `vexplor.integrationBundle-1-sample.zip` | The bundle built from the four files, in this order, `exportedAt` `2026-10-16T00:00:00.000Z` |

```js
import { buildBundle } from '@aas/bundle';
const { zip } = await buildBundle(files, { exportedAt: '2026-10-16T00:00:00.000Z' }); // same bytes as the zip here
```

The format is described in `docs/integration.md` §7.4. `apps/api/test/integration-bundle-build.test.ts` fails when this
zip and the code disagree; after a deliberate change, regenerate everything here with
`AAS_UPDATE_SAMPLES=1 npx vitest run apps/api/test/integration-bundle-build.test.ts`.

견본 묶음입니다. 받는 제품은 위 AASX 4개와 zip 으로 가져오기 시험을 돌립니다. 형식은 `docs/연동.md` §7.4 를 보십시오.
