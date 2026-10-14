/**
 * Reads fixtures and saves them back unchanged (produces the M2 acceptance-review output).
 * Usage: node scripts/roundtrip.mjs <input-dir> <output-dir>
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
    (pkg.warnings.length ? `  [WARN] ${pkg.warnings.length} warnings` : ''),
  );
  count++;
}
console.log(`\nRe-saved ${count} files → ${outDir}`);
