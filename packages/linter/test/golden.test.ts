/**
 * 회귀 기준 — 골든 파일은 KOSMO Validator 전 항목 Passed 확인분이다.
 * 우리 린터가 여기서 위반을 내면 그것은 규칙 구현이 과한 것이지 파일 결함이 아니다.
 */
import { readAasx } from '@aas/aasx';
import { ALL_RULES, L3_RULES, lint } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const FIXTURES = ['01-롤포밍기-공34.aasx', '03-SPR장비-뿌80.aasx', '11-협동로봇6축.aasx'];

function load(name: string) {
  return readAasx(new Uint8Array(readFileSync(root + name)));
}

describe('골든 파일 회귀', () => {
  for (const name of FIXTURES) {
    it(`${name} — 전 계층 규칙에서 위반 0건`, () => {
      const pkg = load(name);
      const result = lint(pkg.environment, ALL_RULES, { package: pkg.opc });

      // 실패 시 무엇이 걸렸는지 바로 보이도록 요약을 붙인다
      const detail = result.findings
        .filter((f) => f.severity === 'error')
        .slice(0, 10)
        .map((f) => `${f.ruleId} @ ${f.kosmoPath}: ${f.message}`)
        .join('\n');
      expect(detail).toBe('');
      expect(result.passed).toBe(true);
    });

    it(`${name} — L3 KOSMO 규칙이 레퍼런스 구현과 같은 판정을 낸다`, () => {
      const pkg = load(name);
      const result = lint(pkg.environment, L3_RULES, { package: pkg.opc });
      expect(result.countBySeverity.error).toBe(0);
    });
  }

  it('규칙 카탈로그가 세 계층을 모두 담고 있다', () => {
    const layers = new Set(ALL_RULES.map((r) => r.layer));
    expect(layers).toEqual(new Set(['L1', 'L2', 'L3']));
    // 🔴 2026-08-24 정정. 예전에는 "AASd-090·AASd-120은 V3에서 삭제됐다"고 적어 두고
    // 구현하지 않았으나 **사실이 아니다** — 둘 다 V3.0 규격에 있다(aas-core-meta v3).
    // KOSMO Validator가 검사하지 않을 뿐이고, 표준 도구(aas-test-engines·basyx)는 강제한다.
    const ids = ALL_RULES.map((r) => r.id);
    expect(ids).toContain('AASd-090');
    expect(ids).toContain('AASd-120');
  });

  it('모든 규칙이 고유한 id와 근거 문서를 갖는다', () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of ALL_RULES) {
      expect(rule.source, `${rule.id}에 근거가 없습니다`).not.toBe('');
      expect(rule.title, `${rule.id}에 제목이 없습니다`).not.toBe('');
    }
  });
});

/**
 * 🔴 **고칠 수 없는 것은 경고로 띄우지 않는다.**
 *
 * 사용자 지적(2026-09-01): 「경고가 떠 있으면 보통 보완하려고 할 텐데, 사전은 고칠 수 없잖아?」
 * 맞는 말이다. 사람이 할 수 있는 일이 없는데 경고가 떠 있으면 고치려 들다가 못 고치고 만다 —
 * 그건 지적이 아니라 잡음이다.
 */
describe('KOSMO-CD-5 — 표준 사전끼리의 이름 겹침', () => {
  it('둘 다 외부 표준 사전(IRDI)이면 경고가 아니라 알림이다', () => {
    const pkg = load('01-롤포밍기-공34.aasx');
    const result = lint(pkg.environment, ALL_RULES, { package: pkg.opc });
    const cd5 = result.findings.filter((f) => f.ruleId === 'KOSMO-CD-5');

    // 골든 파일에는 ManufacturerName·ManufacturerProductDesignation이 각각
    // IEC CDD와 ECLASS 두 벌로 있고 **둘 다 실제로 참조된다**
    expect(cd5.length).toBeGreaterThan(0);
    expect(cd5.every((f) => f.severity === 'info')).toBe(true);
    // 고치라고 하지 않는다 — 합치면 한쪽이 표준 사전을 못 가리키게 된다
    expect(cd5.every((f) => f.remedy?.includes('고치지 마십시오'))).toBe(true);
    expect(cd5.every((f) => f.fixable === false)).toBe(true);
  });

  it('자체 IRI가 섞여 있으면 여전히 경고다 — 그건 우리가 만든 중복이다', () => {
    const pkg = load('01-롤포밍기-공34.aasx');
    const env = structuredClone(pkg.environment);
    // 우리가 만든 CD 하나에 표준 사전 항목과 같은 이름을 붙인다
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
