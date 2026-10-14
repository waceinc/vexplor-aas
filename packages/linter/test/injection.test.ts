/**
 * Fault-injection tests.
 *
 * Applies mutations identical to the 8 measured defects to the golden file and checks that the
 * matching rule actually catches each one. "Zero findings" alone cannot tell whether the linter
 * is working, so the opposite direction is verified too.
 */
import { readAasx } from '@aas/aasx';
import type { Environment, Property, Submodel, SubmodelElementCollection } from '@aas/core';
import { ALL_RULES, lint, type LintResult } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

let goldenEnv: Environment;
let goldenPackage: { parts: string[]; contentTypeOverrides: string[]; relationshipTargets: string[] };

beforeAll(() => {
  const pkg = readAasx(new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx')));
  goldenEnv = pkg.environment;
  goldenPackage = pkg.opc;
});

/** Clones the golden Environment, mutates it, then lints it */
function lintMutated(
  mutate: (env: Environment) => void,
  options: Parameters<typeof lint>[2] = {},
): LintResult {
  const env = structuredClone(goldenEnv);
  mutate(env);
  return lint(env, ALL_RULES, { package: goldenPackage, ...options });
}

function errorsOf(result: LintResult, ruleId: string): string[] {
  return result.findings
    .filter((f) => f.ruleId === ruleId && f.severity === 'error')
    .map((f) => f.message);
}

/** Walks the submodel tree depth-first and returns the first Property */
function firstProperty(sm: Submodel): Property {
  const stack = [...(sm.submodelElements ?? [])];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.modelType === 'Property') return node as Property;
    if ('value' in node && Array.isArray(node.value)) stack.push(...(node.value as never[]));
  }
  throw new Error(`${sm.idShort}에서 Property를 찾지 못했습니다`);
}

describe('L3 KOSMO — reproducing measured defects', () => {
  it('KOSMO-AAS-1: catches an empty defaultThumbnail', () => {
    const result = lintMutated((env) => {
      delete env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail;
    });
    expect(errorsOf(result, 'KOSMO-AAS-1').length).toBe(1);
  });

  it('KOSMO-AAS-1: catches a thumbnail part that does not actually exist', () => {
    const result = lintMutated(
      (env) => {
        env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail = {
          path: '/없는파일.png',
          contentType: 'image/png',
        };
      },
    );
    expect(errorsOf(result, 'KOSMO-AAS-1').length).toBe(1);
    expect(errorsOf(result, 'PKG-THUMB-PART').length).toBe(1);
  });

  it('PKG-THUMB-PART: covered by an extension Default is info, not a violation (program reference model v0.0.1 shape)', () => {
    const pkg = {
      ...goldenPackage,
      contentTypeOverrides: goldenPackage.contentTypeOverrides.filter((p) => p !== '/thumbnail.png'),
      contentTypeDefaults: ['rels', 'xml', 'json', 'png'],
    };
    const result = lint(structuredClone(goldenEnv), ALL_RULES, { package: pkg });
    expect(errorsOf(result, 'PKG-THUMB-PART')).toEqual([]);
    const infos = result.findings.filter((f) => f.ruleId === 'PKG-THUMB-PART' && f.severity === 'info');
    expect(infos.length).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('PKG-THUMB-PART: still a violation with neither Default nor Override', () => {
    const pkg = {
      ...goldenPackage,
      contentTypeOverrides: goldenPackage.contentTypeOverrides.filter((p) => p !== '/thumbnail.png'),
      contentTypeDefaults: ['rels', 'xml', 'json'],
    };
    const result = lint(structuredClone(goldenEnv), ALL_RULES, { package: pkg });
    expect(errorsOf(result, 'PKG-THUMB-PART').length).toBe(1);
  });

  it('KOSMO-AAS-3: reports that the Id format cannot be verified without administration', () => {
    const result = lintMutated((env) => {
      delete env.assetAdministrationShells![0]!.administration;
    });
    expect(errorsOf(result, 'KOSMO-AAS-3')).toEqual([
      'Version 정보가 부족하여 Id 형식을 검증할 수 없습니다.',
    ]);
  });

  it('KOSMO-AAS-3: catches an Id suffix that disagrees with administration (measured defect, round 2)', () => {
    const result = lintMutated((env) => {
      const shell = env.assetAdministrationShells![0]!;
      shell.administration = { version: '3', revision: '1' };
    });
    const messages = errorsOf(result, 'KOSMO-AAS-3');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('기대값 3/1');
  });

  it('KOSMO-AAS-4: catches a missing required submodel', () => {
    const result = lintMutated((env) => {
      env.submodels = env.submodels!.filter((s) => s.idShort !== 'DigitalNameplate');
    });
    const messages = errorsOf(result, 'KOSMO-AAS-4');
    expect(messages.some((m) => m.includes('DigitalNameplate'))).toBe(true);
  });

  it('KOSMO-AAS-4: 9 or more submodel kinds is itself a violation', () => {
    const result = lintMutated((env) => {
      const extra = structuredClone(env.submodels![0]!);
      for (let i = 0; i < 3; i++) {
        const copy = structuredClone(extra);
        copy.id = `${extra.id}/dup${i}`;
        copy.idShort = `Extra${i}`;
        env.submodels!.push(copy);
      }
    });
    const messages = errorsOf(result, 'KOSMO-AAS-4');
    expect(messages.some((m) => m.includes('10종'))).toBe(true);
  });

  it('KOSMO-AAS-6: catches an assetKind other than Type', () => {
    const result = lintMutated((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    });
    expect(errorsOf(result, 'KOSMO-AAS-6')).toHaveLength(1);
  });

  it('KOSMO-SM-3: an admin-shell.io IRI is a violation under the default policy (measured defects, rounds 1 and 3)', () => {
    const result = lintMutated((env) => {
      env.submodels![0]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/zvei/nameplate/3/0/Nameplate' }],
      };
    });
    const findings = result.findings.filter((f) => f.ruleId === 'KOSMO-SM-3');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.policyNote).toContain('이관 대장');
  });

  it('KOSMO-SM-3: warns of the basyx drop risk when the key type is changed to Submodel', () => {
    const result = lintMutated((env) => {
      env.submodels![0]!.semanticId!.keys[0]!.type = 'Submodel';
    });
    const messages = errorsOf(result, 'KOSMO-SM-3');
    expect(messages.some((m) => m.includes('GlobalReference'))).toBe(true);
    // AASd-122 must be caught as well
    expect(errorsOf(result, 'AASd-121~128').length).toBeGreaterThan(0);
  });

  it('KOSMO-SM-4: catches a kind other than Template', () => {
    const result = lintMutated((env) => {
      env.submodels![0]!.kind = 'Instance';
    });
    expect(errorsOf(result, 'KOSMO-SM-4')).toHaveLength(1);
  });

  it('SM-DUP-IDSHORT: warns when two Submodels share a name — golden has 0', () => {
    const clean = lintMutated(() => {});
    expect(clean.findings.filter((f) => f.ruleId === 'SM-DUP-IDSHORT')).toHaveLength(0);

    const result = lintMutated((env) => {
      const twin = structuredClone(env.submodels![0]!);
      twin.id = twin.id + '/2/0'; // different id, same name — the shape an import produces
      env.submodels!.push(twin);
    });
    const dup = result.findings.filter((f) => f.ruleId === 'SM-DUP-IDSHORT');
    expect(dup).toHaveLength(2); // points at both — a person decides which one to remove
    expect(dup[0]!.severity).toBe('warning');
    expect(dup[0]!.message).toContain('DigitalNameplate');
  });

  it('KOSMO-SME-3: catches a missing semanticId on an intermediate SMC (measured defect, round 4)', () => {
    const result = lintMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'OperationalData')!;
      const smc = (sm.submodelElements ?? []).find(
        (e) => e.modelType === 'SubmodelElementCollection',
      ) as SubmodelElementCollection;
      delete smc.semanticId;
    });
    const findings = result.findings.filter(
      (f) => f.ruleId === 'KOSMO-SME-3' && f.message === 'semanticId가 없습니다.',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.elementType).toBe('SubmodelElementCollection');
  });

  it('KOSMO-SME-3: catches a missing corresponding CD', () => {
    const result = lintMutated((env) => {
      env.conceptDescriptions = env.conceptDescriptions!.slice(0, 5);
    });
    const messages = errorsOf(result, 'KOSMO-SME-3');
    expect(messages.length).toBeGreaterThan(50);
    expect(messages.some((m) => m.includes('대응하는 ConceptDescription이 없습니다'))).toBe(true);
  });

  it('KOSMO-SME-4: catches an empty Property value (DN and HD exempt)', () => {
    const result = lintMutated((env) => {
      const td = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      firstProperty(td).value = '';
    });
    expect(errorsOf(result, 'KOSMO-SME-4')).toEqual(['Property에 값이 없습니다.']);
  });

  it('KOSMO-SME-4: empty values in DigitalNameplate are exempt', () => {
    const result = lintMutated((env) => {
      const dn = env.submodels!.find((s) => s.idShort === 'DigitalNameplate')!;
      firstProperty(dn).value = '';
    });
    expect(errorsOf(result, 'KOSMO-SME-4')).toHaveLength(0);
  });

  it('KOSMO-SME-5: catches a valueType/dataType mismatch (measured defect, round 3)', () => {
    const result = lintMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      // Switching a string Property to boolean conflicts with the CD's STRING
      const prop = firstProperty(sm);
      prop.valueType = prop.valueType === 'xs:boolean' ? 'xs:string' : 'xs:boolean';
    });
    const messages = errorsOf(result, 'KOSMO-SME-5');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('valueType과 CD의 dataType이 맞지 않습니다');
  });

  it('KOSMO-CD-4: KOSMO rejects the FILE dataType (measured defect, round 4)', () => {
    const result = lintMutated((env) => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        dataType?: string;
      };
      content.dataType = 'FILE';
    });
    const messages = errorsOf(result, 'KOSMO-CD-4');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('FILE');
  });

  it('KOSMO-CD-3: catches a missing English definition', () => {
    const result = lintMutated((env) => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        definition?: unknown;
      };
      delete content.definition;
      delete cd.description;
    });
    expect(errorsOf(result, 'KOSMO-CD-3')).toHaveLength(1);
  });
});

describe('L2 constraints', () => {
  it('AASd-022: catches duplicate idShorts among sibling elements', () => {
    const result = lintMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      const elems = sm.submodelElements!;
      const copy = structuredClone(elems[0]!);
      elems.push(copy);
    });
    expect(errorsOf(result, 'AASd-022').length).toBeGreaterThan(0);
  });

  it('AASd-108: catches a heterogeneous type inserted into a list', () => {
    const result = lintMutated((env) => {
      for (const sm of env.submodels ?? []) {
        const stack = [...(sm.submodelElements ?? [])];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.modelType === 'SubmodelElementList' && node.value?.length) {
            node.value.push({
              modelType: 'Property',
              idShort: 'Intruder',
              valueType: 'xs:string',
              value: 'x',
            } as Property);
            return;
          }
          if ('value' in node && Array.isArray(node.value)) stack.push(...(node.value as never[]));
        }
      }
    });
    expect(errorsOf(result, 'AASd-107/108/109/114').length).toBeGreaterThan(0);
  });

  it('AASc-3a-009: catches a MEASURE without a unit', () => {
    const result = lintMutated((env) => {
      for (const cd of env.conceptDescriptions ?? []) {
        const content = cd.embeddedDataSpecifications?.[0]?.dataSpecificationContent as {
          dataType?: string;
          unit?: string;
          unitId?: unknown;
        };
        if (content?.dataType === 'REAL_MEASURE') {
          delete content.unit;
          delete content.unitId;
          return;
        }
      }
    });
    expect(errorsOf(result, 'AASc-3a-009')).toHaveLength(1);
  });
});

describe('L1 package', () => {
  it('PKG-FILE-URI: catches a plain relative path', () => {
    const result = lintMutated((env) => {
      for (const sm of env.submodels ?? []) {
        const stack = [...(sm.submodelElements ?? [])];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.modelType === 'File') {
            node.value = '/문서명.pdf';
            return;
          }
          if ('value' in node && Array.isArray(node.value)) stack.push(...(node.value as never[]));
        }
      }
    });
    expect(errorsOf(result, 'PKG-FILE-URI')).toHaveLength(1);
  });

  it('PKG-LANG-DUP: catches a duplicated language tag', () => {
    const result = lintMutated((env) => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        definition?: { language: string; text: string }[];
      };
      content.definition = [
        { language: 'en', text: 'Markings' },
        { language: 'en', text: 'Kennzeichnungen' },
      ];
    });
    expect(errorsOf(result, 'PKG-LANG-DUP')).toHaveLength(1);
  });
});

describe('Policy switches — the 3 rule conflicts are exposed as choices, not hidden', () => {
  it('Conflict 1: with idta-preserve, an IDTA IRI is shown only as a warning', () => {
    const mutate = (env: Environment): void => {
      env.submodels![0]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/zvei/nameplate/3/0/Nameplate' }],
      };
    };

    const strict = lintMutated(mutate);
    const relaxed = lintMutated(mutate, { policy: { iriConflict: 'idta-preserve' } });

    expect(strict.findings.find((f) => f.ruleId === 'KOSMO-SM-3')!.severity).toBe('error');
    const relaxedFinding = relaxed.findings.find((f) => f.ruleId === 'KOSMO-SM-3')!;
    expect(relaxedFinding.severity).toBe('warning');
    expect(relaxedFinding.policyNote).toContain('KOSMO Validator는 이를 거부');
  });

  it('Conflict 2: with allow-empty, a missing CD definition is lowered to info', () => {
    const mutate = (env: Environment): void => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        definition?: unknown;
      };
      delete content.definition;
      delete cd.description;
    };

    expect(lintMutated(mutate).findings.find((f) => f.ruleId === 'KOSMO-CD-3')!.severity).toBe('error');
    const relaxed = lintMutated(mutate, { policy: { cdDefinition: 'allow-empty' } });
    expect(relaxed.findings.find((f) => f.ruleId === 'KOSMO-CD-3')!.severity).toBe('info');
  });

  it('Conflict 3: with preserve, a duplicated language tag is shown only as a warning', () => {
    const mutate = (env: Environment): void => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as { definition?: { language: string; text: string }[] };
      content.definition = [
        { language: 'en', text: 'A' },
        { language: 'en', text: 'B' },
      ];
    };

    expect(lintMutated(mutate).findings.find((f) => f.ruleId === 'PKG-LANG-DUP')!.severity).toBe('error');
    const relaxed = lintMutated(mutate, { policy: { langTagTypo: 'preserve' } });
    expect(relaxed.findings.find((f) => f.ruleId === 'PKG-LANG-DUP')!.severity).toBe('warning');
  });
});

describe('AASd-120 · AASd-090 — in the spec but not checked by KOSMO', () => {
  it('the golden file really violates AASd-120 — surfaced as a warning', () => {
    // Important: this is why basyx cannot read this file (CLAUDE.md),
    // and why aas-test-engines 1.0.3 fails it with 9 errors (measured 2026-08-24)
    const result = lintMutated(() => undefined);
    const violations = result.findings.filter((f) => f.ruleId === 'AASd-120');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe('warning'); // default policy
    // does not block KOSMO submission
    expect(result.passed).toBe(true);
  });

  it('raising the policy to forbid makes it a violation — interoperability-first deployment', () => {
    const result = lintMutated(() => undefined, { policy: { smlChildIdShort: 'forbid' } });
    const violations = result.findings.filter((f) => f.ruleId === 'AASd-120');
    expect(violations[0]!.severity).toBe('error');
    expect(result.passed).toBe(false);
  });

  it('with allow, it is not reported at all', () => {
    const result = lintMutated(() => undefined, { policy: { smlChildIdShort: 'allow' } });
    expect(result.findings.filter((f) => f.ruleId === 'AASd-120')).toHaveLength(0);
  });

  it('AASd-090: catches a category outside the allowed values; empty is fine', () => {
    const withBad = lintMutated((env) => {
      firstProperty(env.submodels![0]!).category = 'DOCUMENT';
    });
    expect(errorsOf(withBad, 'AASd-090')).toHaveLength(1);

    const withGood = lintMutated((env) => {
      firstProperty(env.submodels![0]!).category = 'PARAMETER';
    });
    expect(errorsOf(withGood, 'AASd-090')).toHaveLength(0);

    // The golden file does not use category — which is why this never surfaced before
    expect(errorsOf(lintMutated(() => undefined), 'AASd-090')).toHaveLength(0);
  });
});

describe('Conflict 5 — standard template terms (found while adopting AID)', () => {
  /** An element whose semanticId is a W3C WoT term, as in AID */
  const withStandardTerm = (env: Environment): void => {
    const submodel = env.submodels![0]!;
    submodel.submodelElements!.push({
      modelType: 'Property',
      idShort: 'title',
      valueType: 'xs:string',
      value: 'x',
      semanticId: {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://www.w3.org/2019/wot/td#title' }],
      },
    } as never);
  };

  it('under the default (kosmo-first) it is a violation because there is no CD', () => {
    const result = lintMutated(withStandardTerm);
    expect(errorsOf(result, 'KOSMO-SME-3')).toHaveLength(1);
  });

  it('under preserve it stays as info only and is excluded from fixing', () => {
    // The official template (IDTA-02017) ships no CDs (measured: 0 CDs).
    // Fixing would overwrite the standard terms with our own IRIs and break the template's meaning — also conflicts with KTL §7
    const result = lintMutated(withStandardTerm, {
      policy: { standardTemplateSemantics: 'preserve' },
    });
    expect(errorsOf(result, 'KOSMO-SME-3')).toHaveLength(0);

    const note = result.findings.find((f) => f.ruleId === 'KOSMO-SME-3' && f.severity === 'info')!;
    expect(note.fixable).toBe(false); // the "Fix" action leaves it untouched
    expect(note.policyNote).toContain('KOSMO Validator');
  });

  it('our own IRIs are still violations under preserve — a distinction, not a relaxation', () => {
    const result = lintMutated(
      (env) => {
        const property = firstProperty(env.submodels![0]!);
        property.semanticId = {
          type: 'ExternalReference',
          keys: [{ type: 'GlobalReference', value: 'https://www.smart-factory.kr/ids/cd/없는것/1/0' }],
        };
      },
      { policy: { standardTemplateSemantics: 'preserve' } },
    );
    expect(errorsOf(result, 'KOSMO-SME-3')).toHaveLength(1);
  });
});
