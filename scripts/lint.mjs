/**
 * AASX 규칙 린터 CLI.
 * 사용: node scripts/lint.mjs <파일 또는 디렉터리> [--only KOSMO] [--limit 20]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readAasx } from '@aas/aasx';
import { ALL_RULES, formatReport, formatSummary, lint } from '@aas/linter';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? 'tests/fixtures';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const only = flag('only');
const limit = flag('limit');
const detail = args.includes('--detail');

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter((n) => n.endsWith('.aasx')).map((n) => join(target, n))
  : [target];

let totalErrors = 0;
for (const file of files) {
  const pkg = readAasx(new Uint8Array(readFileSync(file)));
  const result = lint(pkg.environment, ALL_RULES, {
    package: pkg.opc,
    ...(only ? { only: [only] } : {}),
  });
  totalErrors += result.countBySeverity.error;

  if (detail) {
    console.log(formatReport(result, {
      title: file,
      ...(limit ? { limit: Number(limit) } : {}),
    }));
    console.log('');
  } else {
    console.log(formatSummary(result, file));
    for (const [ruleId, count] of Object.entries(result.countByRule)) {
      console.log(`     ${ruleId.padEnd(22)} ${count}건`);
    }
  }
}

console.log(`\n총 위반 ${totalErrors}건`);
process.exit(totalErrors > 0 ? 1 : 0);
