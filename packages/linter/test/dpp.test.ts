/**
 * Digital Product Passport (IDTA 02099-1) — required metadata checks (DPP-1 … DPP-5).
 *
 * The base is the official template shipped in apps/web/public/samples/idta — the rules are checked against the
 * structure IDTA publishes, not against a structure we made up. From it we build one correctly filled passport
 * (0 findings) and then break it one way at a time; each break must be caught by exactly the rule meant for it.
 */
import { readAasx } from '@aas/aasx';
import { setLangSource, type Environment } from '@aas/core';
import { ALL_RULES, DPP_RULES, lint, type Finding } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const samples = fileURLToPath(new URL('../../../apps/web/public/samples/idta/', import.meta.url));
const fixtures = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const template = readAasx(new Uint8Array(readFileSync(samples + 'IDTA-02099-1_DigitalProductPassport_1.0.2.aasx'))).environment;

type Element = Record<string, unknown>;

const VALID: Record<string, string> = {
  digitalProductPassportId: 'https://www.example.org/dpp/1234545',
  uniqueProductIdentifier: 'https://www.example.org/1234545',
  granularity: 'Item',
  dppSchemaVersion: 'ENXXX:v1.0',
  dppStatus: 'Active',
  lastUpdate: '2025-08-22T03:12:00Z',
  economicOperatorId: 'gxx:ppp456789',
  facilityId: 'gxx:xxx987654',
};

function elements(env: Environment): Element[] {
  return env.submodels![0]!.submodelElements as unknown as Element[];
}

function find(env: Environment, idShort: string): Element {
  return elements(env).find((e) => e['idShort'] === idShort)!;
}

/** The official template filled in as an instance passport — the state that must produce no DPP findings */
function filled(): Environment {
  const env = structuredClone(template) as Environment;
  (env.submodels![0] as unknown as Element)['kind'] = 'Instance';
  (env.assetAdministrationShells![0]!.assetInformation as unknown as Element)['assetKind'] = 'Instance';
  for (const [idShort, value] of Object.entries(VALID)) find(env, idShort)['value'] = value;
  for (const child of find(env, 'contentSpecificationIds')['value'] as Element[]) {
    child['value'] = 'https://admin-shell.io/idta/CarbonFootprint/1/0';
  }
  return env;
}

function dpp(env: Environment): Finding[] {
  return lint(env, ALL_RULES).findings.filter((f) => f.ruleId.startsWith('DPP-'));
}

afterEach(() => setLangSource(() => 'ko'));

describe('DPP metadata rules', () => {
  it('a correctly filled passport has no DPP findings', () => {
    expect(dpp(filled())).toEqual([]);
  });

  it('files without a DppMetadata submodel are not affected — the golden machine file gets no DPP findings', () => {
    const golden = readAasx(new Uint8Array(readFileSync(fixtures + '01-roll-forming-machine.aasx'))).environment;
    expect(dpp(golden)).toEqual([]);
  });

  it('the untouched official template (kind Template) gets a warning for each of the 7 required values, no error', () => {
    const found = dpp(template);
    expect(found.filter((f) => f.severity === 'error')).toEqual([]);
    expect(found.filter((f) => f.ruleId === 'DPP-1').map((f) => f.key).sort()).toEqual(
      ['digitalProductPassportId', 'dppSchemaVersion', 'dppStatus', 'economicOperatorId', 'granularity', 'lastUpdate', 'uniqueProductIdentifier'],
    );
  });

  it('DPP-1 — a blank required value in an instance passport is an error; facilityId (0..1) may be blank', () => {
    const env = filled();
    find(env, 'economicOperatorId')['value'] = '  ';
    find(env, 'facilityId')['value'] = '';
    const found = dpp(env);
    expect(found.map((f) => [f.ruleId, f.severity, f.key])).toEqual([['DPP-1', 'error', 'economicOperatorId']]);
  });

  it('DPP-1 — a missing required element is an error, also in a template', () => {
    const env = structuredClone(template) as Environment;
    const list = elements(env);
    list.splice(list.findIndex((e) => e['idShort'] === 'dppStatus'), 1);
    const missing = dpp(env).filter((f) => f.key === 'dppStatus');
    expect(missing.map((f) => [f.ruleId, f.severity])).toEqual([['DPP-1', 'error']]);
  });

  it('DPP-1 — finds the element by semanticId even when the idShort was renamed', () => {
    const env = filled();
    find(env, 'dppStatus')['idShort'] = 'Status';
    expect(dpp(env)).toEqual([]);
  });

  it('DPP-2 — granularity outside Model · Item · Batch is an error', () => {
    const env = filled();
    find(env, 'granularity')['value'] = 'Unit';
    expect(dpp(env).map((f) => [f.ruleId, f.severity, f.key])).toEqual([['DPP-2', 'error', 'granularity']]);
  });

  it('DPP-3 — lastUpdate must be an ISO 8601 timestamp in UTC', () => {
    for (const value of ['2025-08-22 03:12', '2025-08-22T03:12:00+09:00', '2025-13-40T03:12:00Z', '22.08.2025']) {
      const env = filled();
      find(env, 'lastUpdate')['value'] = value;
      expect(dpp(env).map((f) => f.ruleId), value).toEqual(['DPP-3']);
    }
    for (const value of ['2025-08-22T03:12:00Z', '2025-08-22T03:12:00.250Z', '2025-08-22T03:12:00+00:00']) {
      const env = filled();
      find(env, 'lastUpdate')['value'] = value;
      expect(dpp(env), value).toEqual([]);
    }
  });

  it('DPP-4 — contentSpecificationIds, when present, needs at least one non-blank entry (1..*)', () => {
    const empty = filled();
    find(empty, 'contentSpecificationIds')['value'] = [];
    expect(dpp(empty).map((f) => [f.ruleId, f.severity])).toEqual([['DPP-4', 'error']]);

    const blank = filled();
    ((find(blank, 'contentSpecificationIds')['value'] as Element[])[0]!)['value'] = '';
    expect(dpp(blank).map((f) => [f.ruleId, f.severity])).toEqual([['DPP-4', 'error']]);

    const absent = filled();
    const list = elements(absent);
    list.splice(list.findIndex((e) => e['idShort'] === 'contentSpecificationIds'), 1);
    expect(dpp(absent)).toEqual([]);
  });

  it('DPP-5 — granularity and the AAS assetKind must map (Model = Type, Item = Instance)', () => {
    const env = filled();
    find(env, 'granularity')['value'] = 'Model';
    expect(dpp(env).map((f) => [f.ruleId, f.severity])).toEqual([['DPP-5', 'warning']]);
    (env.assetAdministrationShells![0]!.assetInformation as unknown as Element)['assetKind'] = 'Type';
    expect(dpp(env)).toEqual([]);
  });

  it('every DPP rule is registered in ALL_RULES', () => {
    expect(DPP_RULES.map((rule) => rule.id)).toEqual(['DPP-1', 'DPP-2', 'DPP-3', 'DPP-4', 'DPP-5']);
    for (const rule of DPP_RULES) expect(ALL_RULES).toContain(rule);
  });

  it('for an English request, DPP messages · remedies · titles contain no Korean', () => {
    const broken = filled();
    find(broken, 'dppStatus')['value'] = '';
    find(broken, 'granularity')['value'] = 'Unit';
    find(broken, 'lastUpdate')['value'] = 'yesterday';
    find(broken, 'contentSpecificationIds')['value'] = [];
    const list = elements(broken);
    list.splice(list.findIndex((e) => e['idShort'] === 'economicOperatorId'), 1);
    const model = filled();
    find(model, 'granularity')['value'] = 'Model';
    setLangSource(() => 'en');
    const found = [...dpp(broken), ...dpp(model), ...dpp(template)];
    expect(new Set(found.map((f) => f.ruleId)).size).toBe(5);
    const texts = [...found.flatMap((f) => [f.message, f.remedy ?? '', f.policyNote ?? '']), ...DPP_RULES.map((r) => r.title)];
    expect(texts.filter((text) => /[가-힣]/.test(text))).toEqual([]);
  });
});
