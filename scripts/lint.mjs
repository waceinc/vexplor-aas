/**
 * AASX rule linter CLI.
 * Usage: node scripts/lint.mjs <file or directory> [--only KOSMO] [--limit 20] [--detail]
 *
 * A directory is searched with its subfolders (a reference-model repository keeps one folder per machine).
 * Each file is judged by its own metamodel version — the one readAasx reads from it — as the app does.
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

function aasxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name.startsWith('.') ? [] : aasxFiles(path);
      return entry.name.toLowerCase().endsWith('.aasx') ? [path] : [];
    });
}

const files = statSync(target).isDirectory() ? aasxFiles(target) : [target];

let totalErrors = 0;
for (const file of files) {
  const pkg = readAasx(new Uint8Array(readFileSync(file)));
  const result = lint(pkg.environment, ALL_RULES, {
    package: pkg.opc,
    // Important: without it every file is judged as 3.0 — a valid 3.1 file would get 3.0-only errors
    metamodel: pkg.metamodel,
    ...(only ? { only: [only] } : {}),
  });
  totalErrors += result.countBySeverity.error;

  if (detail) {
    console.log(formatReport(result, {
      title: `${file} (V${pkg.metamodel.version})`,
      ...(limit ? { limit: Number(limit) } : {}),
    }));
    console.log('');
  } else {
    console.log(formatSummary(result, `${file} (V${pkg.metamodel.version})`));
    for (const [ruleId, count] of Object.entries(result.countByRule)) {
      console.log(`     ${ruleId.padEnd(22)} ${count}`);
    }
  }
}

console.log(`\nFiles: ${files.length} · total violations: ${totalErrors}`);
process.exit(totalErrors > 0 ? 1 : 0);
