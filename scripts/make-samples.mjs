/**
 * 견본 만들기 — 처음 쓰는 사람이 「견본으로 시작하기」 한 번으로 받는 파일.
 *
 *   node scripts/make-samples.mjs        → apps/web/public/samples/
 *
 * 만드는 것
 *   RollFormingMachine_sample.aasx              설비 1대 (롤포밍기 — 시험 파일을 익명화한 것)
 *   RB01_OptimizationQuality_sample_bundle.zip  레퍼런스 번들 — 공정 구성 + 위 설비 ×2
 *
 * 🔴 견본은 **자동 고치기를 마친 것**을 낸다. 원본 시험 파일은 옛 판이라 리스트 자식에
 *    idShort가 있어(AASd-120) 표준 검증기(aas-test-engines)가 오류 9건으로 떨어뜨리고,
 *    basyx는 요소 175개 중 99개만 읽는다(2026-10-06 실측). 처음 받는 파일이 그러면
 *    「이 도구가 만든 파일은 표준을 못 지킨다」로 읽힌다.
 * 🔴 시험 파일(tests/fixtures)을 바꾸지 않는다 — 그쪽은 「고치기 전」 모습이 시험 대상이다.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readAasx } from '@aas/aasx';
import { createApi } from '@aas/api';
import { InMemoryStore } from '@aas/store';

const SOURCE = 'tests/fixtures/01-롤포밍기-공34.aasx';
const OUT = 'apps/web/public/samples';
const MACHINE = 'RollFormingMachine_sample.aasx';
const PROCESS = 'RB01_OptimizationQuality_sample.aasx';
const BUNDLE = 'RB01_OptimizationQuality_sample_bundle.zip';

const store = new InMemoryStore();
await store.init();
const api = createApi(store);
const call = async (method, path, body, query = {}) => {
  const response = await api({
    method,
    path,
    query,
    queryAll: {},
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body } : {}),
  });
  if (response.status >= 400) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(response.body)}`);
  return response;
};

// ① 설비 — 가져와서 경고까지 고친다
const machine = (await store.importPackage({ name: MACHINE, package: readAasx(new Uint8Array(readFileSync(SOURCE))) })).id;
const fixed = (await call('POST', `/packages/${machine}/fix`, {}, { includeWarnings: '1' })).body;
const after = fixed.after.countBySeverity;
if (after.error > 0 || after.warning > 0) {
  throw new Error(`고친 뒤에도 남았다 — 위반 ${after.error} · 경고 ${after.warning}. 견본으로 내지 않는다`);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/${MACHINE}`, (await call('GET', `/packages/${machine}`)).body);

// ② 공정 구성 — 만들고, 이름에 _sample을 붙여 다시 담는다(새로 만들기는 이름을 자산 이름에서 짓는다)
const made = (await call('POST', '/packages/new', { assetName: 'RB01_OptimizationQuality', unit: 'composite' })).body.packageId;
await call('POST', `/packages/${made}/hierarchy/nodes`, { group: true, name: 'AutoPartsFormingProcess' });
await call('POST', `/packages/${made}/hierarchy/nodes`, { sourcePackageId: machine, parentPath: ['AutoPartsFormingProcess'], bulkCount: 2 });
const proc = (await store.importPackage({ name: PROCESS, package: await store.exportPackage(made) })).id;
await store.deletePackage(made);
const zip = await call('GET', `/packages/${proc}/bundle`, undefined, { code: 'RB01', version: '1.0.0' });
writeFileSync(`${OUT}/${BUNDLE}`, zip.body);

console.log(`견본을 만들었습니다 → ${OUT}`);
console.log(`  ${MACHINE}  (교정 ${fixed.applied.length}건 · 위반 0 · 경고 0)`);
console.log(`  ${BUNDLE}  (${zip.body.length.toLocaleString()} 바이트)`);
