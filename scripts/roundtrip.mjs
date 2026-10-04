/**
 * 픽스처를 읽어 그대로 다시 저장한다 (M2 검수용 산출물 생성).
 * 사용: node scripts/roundtrip.mjs <입력디렉터리> <출력디렉터리>
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readAasx, writeAasx } from '@aas/aasx';

const [inDir = 'tests/fixtures', outDir = 'out/roundtrip'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

let count = 0;
for (const name of readdirSync(inDir).filter((n) => n.endsWith('.aasx'))) {
  const src = new Uint8Array(readFileSync(join(inDir, name)));
  const pkg = readAasx(src);
  const out = writeAasx(pkg);
  writeFileSync(join(outDir, name), out);
  const env = pkg.environment;
  console.log(
    `  ${name}  SM=${env.submodels?.length ?? 0} CD=${env.conceptDescriptions?.length ?? 0}` +
    `  ${src.byteLength} → ${out.byteLength} bytes` +
    (pkg.warnings.length ? `  ⚠ ${pkg.warnings.length}건` : ''),
  );
  count++;
}
console.log(`\n${count}개 재저장 완료 → ${outDir}`);
