/**
 * Regression baseline — the golden files were confirmed Passed on every KOSMO Validator item.
 * If our linter reports a violation here, the rule implementation is too strict, not the file.
 */
import { readAasx } from '@aas/aasx';
import { ALL_RULES, L3_RULES, lint } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const FIXTURES = ['01-roll-forming-machine.aasx', '03-spr-riveting-machine.aasx', '11-cobot-6-axis.aasx'];

function load(name: string) {
  return readAasx(new Uint8Array(readFileSync(root + name)));
}

describe('golden file regression', () => {
  for (const name of FIXTURES) {
    it(`${name} — 0 violations across all rule layers`, () => {
      const pkg = load(name);
      const result = lint(pkg.environment, ALL_RULES, { package: pkg.opc });

      // Attach a summary so a failure shows immediately what was flagged
      const detail = result.findings
        .filter((f) => f.severity === 'error')
        .slice(0, 10)
        .map((f) => `${f.ruleId} @ ${f.kosmoPath}: ${f.message}`)
        .join('\n');
      expect(detail).toBe('');
      expect(result.passed).toBe(true);
    });

    it(`${name} — L3 KOSMO rules give the same verdict as the reference implementation`, () => {
      const pkg = load(name);
      const result = lint(pkg.environment, L3_RULES, { package: pkg.opc });
      expect(result.countBySeverity.error).toBe(0);
    });
  }

  it('the rule catalog covers all three layers', () => {
    const layers = new Set(ALL_RULES.map((r) => r.layer));
    expect(layers).toEqual(new Set(['L1', 'L2', 'L3']));
    // Important: corrected 2026-08-24. We previously noted "AASd-090 and AASd-120 were removed in V3"
    // and left them unimplemented, but **that is false** — both are in the V3.0 spec (aas-core-meta v3).
    // KOSMO Validator just does not check them; standard tools (aas-test-engines, basyx) enforce them.
    const ids = ALL_RULES.map((r) => r.id);
    expect(ids).toContain('AASd-090');
    expect(ids).toContain('AASd-120');
  });

  it('every rule has a unique id and a source document', () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of ALL_RULES) {
      expect(rule.source, `${rule.id}에 근거가 없습니다`).not.toBe('');
      expect(rule.title, `${rule.id}에 제목이 없습니다`).not.toBe('');
    }
  });
});

/**
 * Important: **do not raise a warning for something that cannot be fixed.**
 *
 * User feedback (2026-09-01): "If a warning is showing, people usually try to fix it — but the dictionary can't be fixed, can it?"
 * Correct. If a warning shows when there is nothing a person can do, they try to fix it and fail —
 * that is noise, not a finding.
 */
describe('KOSMO-CD-5 — name collisions between standard dictionaries', () => {
  it('is info, not a warning, when both come from external standard dictionaries (IRDI)', () => {
    const pkg = load('01-roll-forming-machine.aasx');
    const result = lint(pkg.environment, ALL_RULES, { package: pkg.opc });
    const cd5 = result.findings.filter((f) => f.ruleId === 'KOSMO-CD-5');

    // The golden file has ManufacturerName and ManufacturerProductDesignation each in two
    // copies, IEC CDD and ECLASS, and **both are actually referenced**
    expect(cd5.length).toBeGreaterThan(0);
    expect(cd5.every((f) => f.severity === 'info')).toBe(true);
    // Do not ask for a fix — merging would leave one side unable to point to its standard dictionary
    expect(cd5.every((f) => f.remedy?.includes('고치지 마십시오'))).toBe(true);
    expect(cd5.every((f) => f.fixable === false)).toBe(true);
  });

  it('is still a warning when an in-house IRI is involved — that duplicate is ours', () => {
    const pkg = load('01-roll-forming-machine.aasx');
    const env = structuredClone(pkg.environment);
    // Give one of our own CDs the same name as a standard dictionary entry
    env.conceptDescriptions!.push({
      modelType: 'ConceptDescription',
      id: 'https://www.smart-factory.kr/ids/cd/ManufacturerName/1/0',
      idShort: 'ManufacturerName',
    } as never);

    const result = lint(env, ALL_RULES, { package: pkg.opc });
    const cd5 = result.findings.filter(
      (f) => f.ruleId === 'KOSMO-CD-5' && f.key === 'ManufacturerName',
    );
    expect(cd5.some((f) => f.severity === 'warning')).toBe(true);
  });
});
