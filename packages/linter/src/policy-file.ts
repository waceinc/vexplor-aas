/**
 * Policy file — **when conventions change, edit this, not the code.**
 *
 * Rules (logic) and conventions (values) are different in nature.
 *  - **Rules** are logic, so code is the right place (a new rule means writing a function)
 *  - **Conventions** are values — the company IRI root, the list of required submodels, which side to pick in a
 *    regulation conflict. If every change to these means editing code and redeploying, the field cannot change them.
 *
 * Important: **unknown keys and invalid values stop with an error.** If a typo in the policy file were silently ignored,
 *    it would become "I changed it but nothing changed", and it would go all the way to submission like that. That is the worst case.
 */
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';
import { fill, tr } from '@aas/core';

const ENUMS: Partial<Record<keyof LinterPolicy, readonly string[]>> = {
  iriConflict: ['kosmo-first', 'idta-preserve'],
  cdDefinition: ['require-en', 'allow-empty'],
  langTagTypo: ['fix-when-evidence', 'preserve'],
  smlChildIdShort: ['warn', 'forbid', 'allow'],
  standardTemplateSemantics: ['kosmo-first', 'preserve'],
};

const STRING_KEYS: (keyof LinterPolicy)[] = ['iriBase'];
const STRING_ARRAY_KEYS: (keyof LinterPolicy)[] = [
  'irdiPrefixes',
  'requiredSubmodels',
  'valueCheckExemptSubmodels',
];

export class PolicyFileError extends Error {}

export interface ParsedPolicy {
  policy: Partial<LinterPolicy>;
  /** Items that actually differ from the defaults */
  changed: (keyof LinterPolicy)[];
}

/** Reads and validates a policy file (JSON). If it is wrong, states the reason and stops */
export function parsePolicy(text: string): ParsedPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PolicyFileError(fill(tr('정책 파일이 JSON이 아닙니다: {0}'), { 0: String(error) }));
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyFileError(tr('정책 파일은 객체 하나여야 합니다.'));
  }

  const known = new Set(Object.keys(DEFAULT_POLICY));
  const policy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Comment slot — keys starting with `_` are simply skipped (JSON has no comments)
    if (key.startsWith('_')) continue;
    if (!known.has(key)) {
      throw new PolicyFileError(
        fill(tr('모르는 정책 항목입니다: {0} — 쓸 수 있는 것: {1}'), { 0: key, 1: [...known].join(', ') }),
      );
    }

    const enumValues = ENUMS[key as keyof LinterPolicy];
    if (enumValues) {
      if (typeof value !== 'string' || !enumValues.includes(value)) {
        throw new PolicyFileError(
          fill(tr('{0}에 쓸 수 없는 값입니다: {1} — 쓸 수 있는 것: {2}'), { 0: key, 1: JSON.stringify(value), 2: enumValues.join(' · ') }),
        );
      }
      policy[key] = value;
      continue;
    }

    if (STRING_KEYS.includes(key as keyof LinterPolicy)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new PolicyFileError(fill(tr('{0}는 비어 있지 않은 글자여야 합니다.'), { 0: key }));
      }
      policy[key] = value;
      continue;
    }

    if (STRING_ARRAY_KEYS.includes(key as keyof LinterPolicy)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new PolicyFileError(fill(tr('{0}는 글자 목록이어야 합니다.'), { 0: key }));
      }
      policy[key] = value;
      continue;
    }

    if (key === 'submodelCountRange') {
      const range = value as unknown[];
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        range.some((item) => typeof item !== 'number' || !Number.isInteger(item))
      ) {
        throw new PolicyFileError(tr('submodelCountRange는 정수 두 개여야 합니다. 예: [6, 8]'));
      }
      if ((range[0] as number) > (range[1] as number)) {
        throw new PolicyFileError(tr('submodelCountRange의 최솟값이 최댓값보다 큽니다.'));
      }
      policy[key] = range;
      continue;
    }

    throw new PolicyFileError(fill(tr('아직 정책 파일로 바꿀 수 없는 항목입니다: {0}'), { 0: key }));
  }

  const changed = (Object.keys(policy) as (keyof LinterPolicy)[]).filter(
    (key) => JSON.stringify(policy[key]) !== JSON.stringify(DEFAULT_POLICY[key]),
  );
  return { policy: policy as Partial<LinterPolicy>, changed };
}

/** Where each value in use came from — shown on the rules screen */
export function policySources(
  policy: Partial<LinterPolicy>,
): { key: keyof LinterPolicy; from: 'default' | 'policy-file' }[] {
  return (Object.keys(DEFAULT_POLICY) as (keyof LinterPolicy)[]).map((key) => ({
    key,
    // Language-independent marker — a value the screen (Rules.tsx) compares against and never displays (so Korean does not leak to API consumers using English)
    from: key in policy && JSON.stringify(policy[key]) !== JSON.stringify(DEFAULT_POLICY[key]) ? 'policy-file' : 'default',
  }));
}
