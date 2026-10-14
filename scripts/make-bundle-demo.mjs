/**
 * Reference-bundle demo kit — uses one roll-forming machine to show both the "submission bundle" and the "on-site demo".
 *
 *   node scripts/make-bundle-demo.mjs                       -> out/demo/reference-bundle/
 *   node scripts/make-bundle-demo.mjs --source <roll-forming.aasx>  to build from the project submission copy (v0.0.1).
 *     The default is the repository's golden file (tests/fixtures) — an old version, so 10 AASd-120 warnings appear
 *
 * Outputs (both opened with "Open bundle")
 *   ①_제출형_…zip   the bundle itself. Reference model (Type), quantity x2, **no collection connection** — the shape that is submitted/published
 *   ②_시연용_…zip   imitates a pilot site. Two per-unit files (RollFormingMachine_1, _2), each connected to the virtual PLC
 *   가상PLC/        unit files of (2) — the virtual PLC exposes tags named after these files' operational data
 *   가상PLC_시작.bat · 시연순서.md
 *
 * Important: why split in two — a bundle is a Type, so having no endpoint address is correct; values flow from
 *    each individual physical machine (Instance). Mixing both in one file would leak the demo address into the submission.
 * Important: every value in (2) is **simulated**. The interface name says so explicitly.
 * Important: the kit itself (file names, the virtual PLC title, the presenter script) stays Korean on purpose — it is
 *    run in front of Korean customers and quotes the Korean UI labels; 02_참조모델 is a folder name fixed by the bundle format.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAasx, unzipArchive } from '@aas/aasx';
import { createApi } from '@aas/api';
import { simulationPlan } from '@aas/opcua';
import { InMemoryStore } from '@aas/store';

const sourceAt = process.argv.indexOf('--source');
const GOLDEN = sourceAt > 0 ? process.argv[sourceAt + 1] : 'tests/fixtures/01-roll-forming-machine.aasx';
const OUT = resolve('out/demo/reference-bundle');
const SIM_PORT = 14850;
const ENDPOINT = `opc.tcp://127.0.0.1:${SIM_PORT}/UA/Simulator`;

async function session() {
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
  const machine = (await store.importPackage({ name: '01-roll-forming-machine.aasx', package: readAasx(new Uint8Array(readFileSync(GOLDEN))) })).id;
  return { store, call, machine };
}

const filenameOf = (response) => decodeURIComponent(response.headers['content-disposition'].split("UTF-8''")[1]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/가상PLC`, { recursive: true });

// ── (1) Submission bundle ───────────────────────────────────────────────────────────
{
  const { call, machine } = await session();
  const proc = (await call('POST', '/packages/new', { assetName: 'RB01_OptimizationQuality', unit: 'composite' })).body.packageId;
  await call('POST', `/packages/${proc}/hierarchy/nodes`, { group: true, name: 'AutoPartsFormingProcess' });
  await call('POST', `/packages/${proc}/hierarchy/nodes`, { sourcePackageId: machine, parentPath: ['AutoPartsFormingProcess'], bulkCount: 2 });
  const zip = await call('GET', `/packages/${proc}/bundle`, undefined, { code: 'RB01', version: '1.0.0' });
  writeFileSync(`${OUT}/①_제출형_${filenameOf(zip)}`, zip.body);
}

// ── (2) Demo — per unit + virtual PLC connection ─────────────────────────────────────────
{
  const { store, call, machine } = await session();
  const units = [];
  for (const name of ['RollFormingMachine_1', 'RollFormingMachine_2']) {
    const id = (await call('POST', `/packages/${machine}/clone`, { assetName: name })).body.packageId;
    // Tags = exactly the tags the virtual PLC will create from this file. On duplicate names keep the first (AID names must be unique)
    const plan = simulationPlan((await store.exportPackage(id)).environment);
    const seen = new Set();
    const tags = plan.tags
      .filter((tag) => !seen.has(tag.name) && seen.add(tag.name))
      .map((tag) => ({
        name: tag.name,
        href: `ns=1;s=${tag.nodeId}`,
        type: { Double: 'float', Int32: 'integer', Boolean: 'boolean', String: 'string' }[tag.dataType],
      }));
    await call('POST', `/packages/${id}/aid`, { endpoint: ENDPOINT, title: '가상 PLC (시뮬레이션)', tags });
    units.push({ id, name, tags: tags.length });
  }
  // The original (Type) file is not needed for this demo — keep only the unit files
  await call('DELETE', `/packages/${machine}`);

  const proc = (await call('POST', '/packages/new', { assetName: 'PilotDemo_FormingLine', unit: 'composite' })).body.packageId;
  await call('POST', `/packages/${proc}/hierarchy/nodes`, { group: true, name: 'RollFormingLine' });
  for (const unit of units) {
    await call('POST', `/packages/${proc}/hierarchy/nodes`, { sourcePackageId: unit.id, parentPath: ['RollFormingLine'] });
  }
  const zip = await call('GET', `/packages/${proc}/bundle`, undefined, { code: 'RB01', title: 'Pilot시연_롤포밍라인', version: '1.0.0' });
  writeFileSync(`${OUT}/②_시연용_${filenameOf(zip)}`, zip.body);

  // Unit files for the virtual PLC — extracted unchanged from the bundle (must be the same file for tags to match)
  for (const [path, data] of Object.entries(unzipArchive(zip.body))) {
    if (path.includes('/02_참조모델/')) writeFileSync(`${OUT}/가상PLC/${path.split('/').pop()}`, data);
  }
  console.log(`Units ${units.map((u) => `${u.name} (${u.tags} tags)`).join(' · ')}`);
}

const repo = resolve('.');
writeFileSync(
  `${OUT}/가상PLC_시작.bat`,
  [
    '@echo off',
    'chcp 65001 >nul',
    'title 가상 PLC (시뮬레이션) - 롤포밍 라인',
    `cd /d "${repo}"`,
    `node scripts\\plc-simulator.mjs ${SIM_PORT} --from "${OUT}\\가상PLC\\RollFormingMachine_1.aasx" --from "${OUT}\\가상PLC\\RollFormingMachine_2.aasx"`,
    'pause',
    '',
  ].join('\r\n'),
);

writeFileSync(
  `${OUT}/시연순서.md`,
  `# 레퍼런스 번들 시연 — 롤포밍기 (약 5분)

> [주의] ② 의 값은 **시뮬레이션**입니다. 화면·캡처에 그렇게 말하고 적으십시오.

## 준비
1. 저작 도구를 띄웁니다(개발판이면 http://localhost:5173).
2. **가상PLC_시작.bat** 을 두 번 눌러 창을 띄워 둡니다 — 「가상 PLC(OPC UA, 시뮬레이션)가 떴습니다」.

## ① 제출형 번들 — "이것이 제출되는 산출물입니다"
1. 위 「번들 열기」 → **①_제출형_…zip**
2. 알림 띠: 파일 2개 · **해시 일치 2/2** → 만든 뒤 한 글자도 안 바뀌었다는 증명
3. ③ 제출 → 「레퍼런스 번들」: 자동차 성형공정 › 롤포밍기 **×2**, 사전 점검 ✓
4. 말할 것: "번들은 **형식(Type)** 이라 현장 주소가 없습니다. 어느 회사든 내려받아 자기 설비에 씁니다.
   같은 기종 2대는 ×2로 적습니다 — 파일을 복사하면 같은 내용이 두 벌이 되어 고칠 때 어긋납니다."

## ② 현장 시연 — "그 틀을 실제 라인에 붙이면 이렇게 됩니다"
1. 「번들 열기」 → **②_시연용_…zip**
2. 「레퍼런스 번들」: RollFormingMachine_1 · _2 두 대, 카드에 **⚡ 수집 연결 · 시연본**
   매트릭스가 두 대 모두 파랗게 차 있음 → 호기끼리 같은 항목을 그대로 모을 수 있다
3. 설비 카드(_1)를 눌러 그 파일로 이동 → 오른쪽 **수집** → ⚪ 수집 전 → **「수집」** → 🟢 **연결됨**
4. 몇 번 더 누르면 값이 바뀝니다. 40초마다 5초간 MachineState가 **ALARM**으로 바뀝니다
5. 말할 것: "번들의 표준 모델 그대로 현장 값이 들어옵니다. 모델 이름과 태그 이름이 같아 매핑 작업이 없습니다."

## ③ 제출용 번들에 증빙 싣기 — 시연을 못 하는 자리를 위해
제출할 때는 시연을 못 합니다. 대신 **수집 기록**을 번들에 넣습니다.
1. ①·②를 둘 다 연 채로, 서버를 자동 수집으로 띄워 10~30분 둡니다
   (\`COLLECT=on COLLECT_INTERVAL=5 node apps/api/dist/server.js\`)
2. ① 공정 파일(RB01_OptimizationQuality)을 열고 「레퍼런스 번들」 → **③ 실동작 증빙**에 호기 _1·_2의 수집 건수가 보입니다
   — ②의 호기는 ①의 롤포밍기에서 **파생**됐다는 기록(derivedFrom)이 있어 자동으로 이어집니다
3. 증빙 수준 **자동(C)** 그대로 「번들 내보내기」
4. 받은 ZIP에 \`05_샘플데이터/수집값_*.csv\`와 \`06_검증결과/수집기록.html\`(인쇄하면 PDF)이 들어 있습니다.
   ①의 참조모델은 그대로(수집 연결 없음)입니다 — 이것을 제출합니다

## 마무리 질문 대비
- 왜 ①에는 연결이 없나 → 제출·공개물에 특정 현장 주소가 들어가면 안 됩니다(Type/Instance 구분)
- 실제 PLC면 → 수집 연결의 주소만 바꾸면 됩니다
- 공식 검증은 → 모델은 장비별 AASX를 만들 때 KOSMO Validator로 받았습니다. 번들은 그 판을 해시로 묶고, 화면의 ✓는 다시 확인한 참고 표시입니다
`,
);

console.log(`Created: ${OUT}`);
