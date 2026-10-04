/**
 * 모든 package.json에 라이선스를 적는다.
 *
 *     node scripts/set-license.mjs
 *
 * 🔴 `private: true`는 **그대로 둔다.** 이것은 "비공개 소프트웨어"라는 뜻이 아니라
 *    "npm 레지스트리에 올리지 않는다"는 뜻이다. 이 저장소는 라이브러리가 아니라
 *    통째로 띄우는 애플리케이션이라, 실수로 `npm publish`가 되는 것을 막는 쪽이 맞다.
 *
 * 줄 순서를 흩뜨리지 않으려고 `version` 바로 뒤에 끼운다 — JSON을 통째로 다시 쓰면
 * 손으로 맞춰 둔 순서가 바뀌어 차이(diff)가 지저분해진다.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const LICENSE = 'Apache-2.0';
const files = [
  'package.json',
  ...readdirSync('packages').map((name) => `packages/${name}/package.json`),
  ...readdirSync('apps').map((name) => `apps/${name}/package.json`),
];

for (const file of files) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.license === LICENSE) {
    console.log(`그대로  ${file}`);
    continue;
  }
  const ordered = {};
  let placed = false;
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'license') continue;
    ordered[key] = value;
    if (key === 'version') {
      ordered.license = LICENSE;
      placed = true;
    }
  }
  if (!placed) ordered.license = LICENSE;
  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`적음    ${file}`);
}
