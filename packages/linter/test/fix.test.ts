/**
 * Quick Fix verification.
 *
 * Pairs with the defect-injection test (injection.test.ts) — that one checks "is it caught?",
 * this one checks "does the fixed result actually pass?".
 * If a fix newly breaks another rule, after.error becomes non-zero, so the regression shows up immediately.
 */
import { readAasx, writeAasx } from '@aas/aasx';
import type {
  ConceptDescription,
  Environment,
  File as AasFile,
  Property,
  Submodel,
  SubmodelElement,
} from '@aas/core';
import { ALL_RULES, lint, lintAndFix, type ApplyFixOptions, type LintAndFixResult } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

let golden: ReturnType<typeof readAasx>;

beforeAll(() => {
  golden = readAasx(new Uint8Array(readFileSync(root + '01-roll-forming-machine.aasx')));
});

/** Clones the golden Environment, injects a defect, then lint → fix → re-lint */
function fixMutated(
  mutate: (env: Environment) => void,
  options: ApplyFixOptions = {},
): LintAndFixResult & { env: Environment } {
  const env = structuredClone(golden.environment);
  mutate(env);
  const result = lintAndFix(env, { package: golden.opc, ...options });
  // Confirm the injection actually produced a violation — without this, a pass could be vacuous
  expect(result.before.countBySeverity.error).toBeGreaterThan(0);
  return { ...result, env: result.environment };
}

function errorsOf(findings: readonly { ruleId: string; severity: string }[], ruleId: string): number {
  return findings.filter((f) => f.ruleId === ruleId && f.severity === 'error').length;
}

/** Remaining violations after fixing, in human-readable form — so the cause is obvious on failure */
function remaining(result: LintAndFixResult): string {
  return result.after.findings
    .filter((f) => f.severity === 'error')
    .map((f) => `${f.ruleId} @ ${f.kosmoPath}: ${f.message}`)
    .join('\n');
}

function allElements(sm: Submodel): SubmodelElement[] {
  const out: SubmodelElement[] = [];
  const walk = (items: SubmodelElement[]): void => {
    for (const node of items) {
      out.push(node);
      const children = (node as { value?: unknown }).value;
      if (Array.isArray(children)) walk(children as SubmodelElement[]);
      const statements = (node as { statements?: SubmodelElement[] }).statements;
      if (statements) walk(statements);
    }
  };
  walk(sm.submodelElements ?? []);
  return out;
}

function findElement(
  env: Environment,
  predicate: (node: SubmodelElement, sm: Submodel) => boolean,
): { node: SubmodelElement; submodel: Submodel } {
  for (const sm of env.submodels ?? []) {
    for (const node of allElements(sm)) {
      if (predicate(node, sm)) return { node, submodel: sm };
    }
  }
  throw new Error('조건에 맞는 요소를 찾지 못했습니다');
}

describe('Quick Fix — fixing the 8 observed defect types', () => {
  it('KOSMO-AAS-1: fills a missing thumbnail by finding it among the package parts', () => {
    const r = fixMutated((env) => {
      delete env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail;
    });
    expect(r.env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail).toEqual({
      path: '/thumbnail.png',
      contentType: 'image/png',
    });
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-AAS-1: without package info, does not fix and records the reason', () => {
    const env = structuredClone(golden.environment);
    delete env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail;
    const r = lintAndFix(env); // package not given
    expect(r.applied.filter((a) => a.ruleId === 'KOSMO-AAS-1')).toHaveLength(0);
    expect(r.skipped.some((s) => s.ruleId === 'KOSMO-AAS-1' && s.reason.includes('패키지 정보'))).toBe(true);
  });

  it('KOSMO-AAS-3: derives administration from the id suffix when it is missing', () => {
    const r = fixMutated((env) => {
      delete env.assetAdministrationShells![0]!.administration;
    });
    expect(r.env.assetAdministrationShells![0]!.administration).toEqual({ version: '1', revision: '0' });
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SM-2: fixes a mismatched id suffix and updates the AAS references too', () => {
    const target = golden.environment.submodels!.findIndex((s) => s.idShort === 'OperationalData');
    const oldId = golden.environment.submodels![target]!.id;

    const r = fixMutated((env) => {
      env.submodels![target]!.administration = { version: '2', revision: '3' };
    });

    const fixed = r.env.submodels![target]!;
    expect(fixed.id.endsWith('/2/3')).toBe(true);
    // Referential integrity — the AAS submodels[] and its own semanticId must follow along
    const refs = (r.env.assetAdministrationShells![0]!.submodels ?? []).flatMap((ref) =>
      ref.keys.map((k) => k.value),
    );
    expect(refs).toContain(fixed.id);
    expect(refs).not.toContain(oldId);
    expect(fixed.semanticId!.keys[0]!.value).toBe(fixed.id);
    // The original is kept in the migration log
    expect(r.relocations[fixed.id]).toBe(oldId);
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-AAS-5: builds globalAssetId per the convention', () => {
    const r = fixMutated((env) => {
      delete env.assetAdministrationShells![0]!.assetInformation.globalAssetId;
    });
    expect(r.env.assetAdministrationShells![0]!.assetInformation.globalAssetId).toBe(
      'https://www.smart-factory.kr/ids/asset/RollFormingMachine/1/0',
    );
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-AAS-6 · SM-4: reverts to Type · Template', () => {
    const r = fixMutated((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
      env.submodels![0]!.kind = 'Instance';
    });
    expect(r.env.assetAdministrationShells![0]!.assetInformation.assetKind).toBe('Type');
    expect(r.env.submodels![0]!.kind).toBe('Template');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SM-3: moves a non-allowlisted semanticId to its own id and records the original in the log', () => {
    const idtaIri = 'https://admin-shell.io/zvei/nameplate/3/0/Nameplate';
    const r = fixMutated((env) => {
      env.submodels![0]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: idtaIri }],
      };
    });
    const sm = r.env.submodels![0]!;
    expect(sm.semanticId!.keys[0]!.value).toBe(sm.id);
    expect(r.relocations[sm.id]).toBe(idtaIri);
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SM-3: reverts a key type changed to Submodel back to GlobalReference (prevents basyx drop)', () => {
    const r = fixMutated((env) => {
      env.submodels![0]!.semanticId!.keys[0]!.type = 'Submodel';
    });
    expect(r.env.submodels![0]!.semanticId!.keys[0]!.type).toBe('GlobalReference');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-CD-2: moves a non-allowlisted CD id to the in-house IRI convention and updates references', () => {
    const index = golden.environment.conceptDescriptions!.findIndex(
      (cd) => cd.id === 'https://www.smart-factory.kr/ids/cd/AlarmActive/1/0',
    );
    const canonical = golden.environment.conceptDescriptions![index]!.id;

    const r = fixMutated((env) => {
      const cd = env.conceptDescriptions![index]!;
      const oldId = cd.id;
      cd.id = 'https://example.com/AlarmActive';
      // Move the references too — the same shape as the real migration incident
      for (const sm of env.submodels ?? []) {
        for (const node of allElements(sm)) {
          const key = node.semanticId?.keys?.[0];
          if (key?.value === oldId) key.value = cd.id;
        }
      }
    });

    const cd = r.env.conceptDescriptions![index]!;
    expect(cd.id).toBe(canonical);
    expect(r.relocations[canonical]).toBe('https://example.com/AlarmActive');
    // Did the references follow — the old id must not remain anywhere
    expect(JSON.stringify(r.env)).not.toContain('https://example.com/AlarmActive');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-3: adds a semanticId per the convention when missing, and creates the CD when missing', () => {
    const { node } = findElement(golden.environment, (n) => n.modelType === 'Property');
    const idShort = node.idShort!;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'Property');
      delete target.node.semanticId;
    });

    const fixed = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'Property');
    const semantic = fixed.node.semanticId!.keys[0]!.value;
    expect(semantic).toContain('/ids/cd/');
    expect(r.env.conceptDescriptions!.some((cd) => cd.id === semantic)).toBe(true);
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-3: creates the CD for an idShort-less list child from the singular of the parent list name (Markings → Marking)', () => {
    // The state after the AASd-120 fix — the CD that an idShort-less list child's semanticId points to is missing.
    // Previously this was skipped with "cannot create a ConceptDescription because idShort is missing", so the button count and the popup disagreed (2026-09-11)
    let semantic = '';
    const r = fixMutated((env) => {
      const { node } = findElement(env, (n) => n.idShort === 'Markings' && n.modelType === 'SubmodelElementList');
      const child = (node as { value?: SubmodelElement[] }).value![0]!;
      semantic = child.semanticId!.keys[0]!.value;
      delete child.idShort;
      env.conceptDescriptions = env.conceptDescriptions!.filter((cd) => cd.id !== semantic);
    });
    const created = r.env.conceptDescriptions!.find((cd) => cd.id === semantic);
    expect(created?.idShort).toBe('Marking');
    expect(r.skipped.filter((s) => s.ruleId === 'KOSMO-SME-3')).toEqual([]);
    expect(remaining(r)).toBe('');
  });

  it('AASd-109: fills a missing valueTypeListElement on a Property list from the children valueType', () => {
    const r = fixMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      sm.submodelElements!.push({
        modelType: 'SubmodelElementList',
        idShort: 'SpindleTemps',
        typeValueListElement: 'Property',
        value: [
          { modelType: 'Property', valueType: 'xs:double', value: '41.5' },
          { modelType: 'Property', valueType: 'xs:double', value: '42.0' },
        ],
      } as never);
    });
    const list = findElement(r.env, (n) => n.idShort === 'SpindleTemps').node as { valueTypeListElement?: string };
    expect(list.valueTypeListElement).toBe('xs:double');
    expect(r.after.findings.filter((f) => f.ruleId === 'AASd-107/108/109/114' && f.severity === 'error')).toEqual([]);
  });

  it('KOSMO-SME-3: when a CD is missing entirely, recreates it in the same shape as the golden file', () => {
    const { node } = findElement(
      golden.environment,
      (n) => n.modelType === 'Property' && (n.semanticId?.keys[0]?.value ?? '').includes('/ids/cd/'),
    );
    const semantic = node.semanticId!.keys[0]!.value;

    const r = fixMutated((env) => {
      env.conceptDescriptions = env.conceptDescriptions!.filter((cd) => cd.id !== semantic);
    });

    const created = r.env.conceptDescriptions!.find((cd) => cd.id === semantic);
    expect(created).toBeDefined();
    expect(created!.idShort).toBe(node.idShort);
    const content = created!.embeddedDataSpecifications![0]!.dataSpecificationContent as unknown as {
      preferredName: { language: string; text: string }[];
      dataType?: string;
    };
    expect(content.preferredName[0]).toEqual({ language: 'en', text: node.idShort });
    expect(content.dataType).toBeDefined();
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-5: for an in-house CD, aligns the CD dataType to the Property', () => {
    const { node } = findElement(
      golden.environment,
      (n) =>
        n.modelType === 'Property' &&
        (n as Property).valueType === 'xs:string' &&
        (n.semanticId?.keys[0]?.value ?? '').includes('/ids/cd/'),
    );
    const semantic = node.semanticId!.keys[0]!.value;
    const idShort = node.idShort!;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'Property');
      (target.node as Property).valueType = 'xs:boolean';
    });

    const cd = r.env.conceptDescriptions!.find((c) => c.id === semantic)!;
    const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as unknown as { dataType?: string };
    expect(content.dataType).toBe('BOOLEAN');
    // Our valueType is left untouched
    const fixed = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'Property');
    expect((fixed.node as Property).valueType).toBe('xs:boolean');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-5: for an external standard dictionary (IRDI) CD, aligns the Property valueType instead', () => {
    // Pick a Property pointing to an IRDI CD and make only its valueType mismatch
    const found = findElement(
      golden.environment,
      (n) => n.modelType === 'Property' && (n.semanticId?.keys[0]?.value ?? '').startsWith('0112/'),
    );
    const idShort = found.node.idShort!;
    const semantic = found.node.semanticId!.keys[0]!.value;
    const cd = golden.environment.conceptDescriptions!.find((c) => c.id === semantic)!;
    const dataType = (cd.embeddedDataSpecifications![0]!.dataSpecificationContent as unknown as { dataType?: string })
      .dataType;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'Property');
      (target.node as Property).valueType = 'xs:boolean';
    });

    const fixedCd = r.env.conceptDescriptions!.find((c) => c.id === semantic)!;
    const fixedContent = fixedCd.embeddedDataSpecifications![0]!.dataSpecificationContent as unknown as {
      dataType?: string;
    };
    // The external CD stays as is
    expect(fixedContent.dataType).toBe(dataType);
    // and our valueType changes
    const fixedProp = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'Property');
    expect((fixedProp.node as Property).valueType).not.toBe('xs:boolean');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-CD-4: normalizes a non-allowlisted dataType to STRING', () => {
    const r = fixMutated((env) => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as unknown as { dataType?: string };
      content.dataType = 'FILE';
    });
    const content = r.env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as unknown as { dataType?: string };
    expect(content.dataType).toBe('STRING');
    expect(remaining(r)).toBe('');
  });

  it('Important: AASc-3a-009: does not invent a unit; downgrades dataType to COUNT instead', () => {
    // We cannot know whether "12.5" is kW or A — a wrong unit is more dangerous than none
    const r = fixMutated((env) => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as unknown as { dataType?: string; unit?: string };
      content.dataType = 'REAL_MEASURE';
      delete content.unit;
    });
    const content = r.env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as unknown as { dataType?: string; unit?: string };
    expect(content.dataType).toBe('REAL_COUNT');
    // No unit was made up
    expect(content.unit).toBeUndefined();
    expect(remaining(r)).toBe('');
    // Leaves a note to revert — this is for a human to decide
    expect(r.applied.some((a) => a.description.includes('되돌리십시오'))).toBe(true);
  });

  it('AASc-3a-009: is not flagged in the first place when a unit already exists', () => {
    // Important: do not use fixMutated — it first checks that "a violation was produced",
    //    whereas here we check the exact opposite: **that no violation is produced**
    const env = structuredClone(golden.environment);
    const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as unknown as { dataType?: string; unit?: string };
    content.dataType = 'REAL_MEASURE';
    content.unit = 'rpm';
    const r = lintAndFix(env, { package: golden.opc });
    expect(errorsOf(r.before.findings, 'AASc-3a-009')).toBe(0);
    expect(content.dataType).toBe('REAL_MEASURE');
  });

  it('PKG-FILE-URI: adds the file:// scheme to a relative-path File.value', () => {
    const found = findElement(golden.environment, (n) => n.modelType === 'File');
    const idShort = found.node.idShort!;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'File');
      (target.node as AasFile).value = 'suppl/manual.pdf';
    });

    const fixed = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'File');
    expect((fixed.node as AasFile).value).toBe('file:///suppl/manual.pdf');
    expect(remaining(r)).toBe('');
  });

  it('PKG-LANG-DUP: removes only the later duplicate language tag and leaves the text untouched', () => {
    const r = fixMutated((env) => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as unknown as { preferredName: { language: string; text: string }[] };
      content.preferredName.push({ language: 'en', text: '나중에 들어온 오타본' });
    });

    const content = r.env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as unknown as { preferredName: { language: string; text: string }[] };
    expect(content.preferredName.filter((s) => s.language === 'en')).toHaveLength(1);
    expect(content.preferredName.some((s) => s.text === '나중에 들어온 오타본')).toBe(false);
    expect(remaining(r)).toBe('');
  });
});

describe('Quick Fix — contract', () => {
  it('does not mutate the input Environment', () => {
    const env = structuredClone(golden.environment);
    const snapshot = JSON.stringify(env);
    env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    const mutated = JSON.stringify(env);

    lintAndFix(env, { package: golden.opc });
    expect(JSON.stringify(env)).toBe(mutated);
    expect(mutated).not.toBe(snapshot); // Confirm the injection actually took effect
  });

  it('runs a single pass and stops when there is nothing to fix', () => {
    const r = lintAndFix(golden.environment, { package: golden.opc });
    expect(r.applied).toHaveLength(0);
    expect(r.rounds).toBe(1);
    expect(r.after.countBySeverity.error).toBe(0);
  });

  it('does not silently skip rules without a fixer; records the reason', () => {
    // KOSMO-CD-5 (duplicate id) is fixable but not auto-fixed — a human has to merge
    const r = fixMutated((env) => {
      const cd = structuredClone(env.conceptDescriptions![0]!) as ConceptDescription;
      env.conceptDescriptions!.push(cd);
    });
    expect(errorsOf(r.after.findings, 'KOSMO-CD-5')).toBeGreaterThan(0);
    expect(r.skipped.some((s) => s.ruleId === 'KOSMO-CD-5' && s.reason.includes('자동 교정기'))).toBe(true);
  });

  it('converges by iteration on defects that do not all surface at once', () => {
    const r = fixMutated((env) => {
      const shell = env.assetAdministrationShells![0]!;
      shell.assetInformation.assetKind = 'Instance';
      delete shell.assetInformation.globalAssetId;
      delete shell.assetInformation.defaultThumbnail;
      delete env.submodels![0]!.administration; // the id check only opens up after administration is created
      env.submodels![1]!.kind = 'Instance';
      env.submodels![2]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/x/1/0' }],
      };
    });
    expect(remaining(r)).toBe('');
    expect(r.before.countBySeverity.error).toBeGreaterThan(0);
    expect(r.applied.length).toBeGreaterThanOrEqual(6);
    expect(r.rounds).toBeLessThanOrEqual(5);
  });

  it('the fixed result saved as AASX and read back has 0 violations', () => {
    const env = structuredClone(golden.environment);
    env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    delete env.assetAdministrationShells![0]!.assetInformation.globalAssetId;
    env.submodels![0]!.kind = 'Instance';

    const fixed = lintAndFix(env, { package: golden.opc });
    const bytes = writeAasx({ ...golden, environment: fixed.environment });
    const reread = readAasx(bytes);
    const result = lint(reread.environment, ALL_RULES, { package: reread.opc });

    expect(result.countBySeverity.error).toBe(0);
    expect(result.passed).toBe(true);
  });
});

describe('Quick Fix — spec compliance (AASd-120 · AASd-090)', () => {
  it('removes idShort from SML children — into a form standard tools accept', () => {
    const env = structuredClone(golden.environment);
    const before = lint(env, ALL_RULES, {
      package: golden.opc,
      policy: { smlChildIdShort: 'forbid' },
    });
    expect(before.countBySeverity.error).toBeGreaterThan(0);

    const result = lintAndFix(env, {
      package: golden.opc,
      policy: { smlChildIdShort: 'forbid' },
    });
    expect(result.after.countBySeverity.error).toBe(0);
    expect(result.applied.some((a) => a.ruleId === 'AASd-120')).toBe(true);
    // Removed values are recorded — it must be reversible
    const applied = result.applied.find((a) => a.ruleId === 'AASd-120')!;
    expect(applied.before).toBe('MarkingsEntry_0');

    // KOSMO rules stay at 0 — removal does not affect submission
    const kosmo = lint(result.environment, ALL_RULES, { package: golden.opc });
    expect(kosmo.countBySeverity.error).toBe(0);
  });

  it('removes a category outside the allowed values — a human decides what to replace it with', () => {
    const r = fixMutated((env) => {
      const property = findElement(env, (n) => n.modelType === 'Property').node;
      property.category = 'DOCUMENT';
    });
    expect(remaining(r)).toBe('');
    const applied = r.applied.find((a) => a.ruleId === 'AASd-090')!;
    expect(applied.before).toBe('DOCUMENT');
    expect(applied.after).toBeUndefined();
  });
});
