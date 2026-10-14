/**
 * Policy file — the way to change values, not code, when the conventions change.
 *
 * Important: half of these tests check that **a wrong file is rejected**.
 *    If a typo is silently ignored, it becomes "I changed it but nothing changed", and it goes all the way to submission like that.
 */
import { DEFAULT_POLICY, parsePolicy, policySources, PolicyFileError } from '@aas/linter';
import { describe, expect, it } from 'vitest';

describe('Reading the policy file', () => {
  it('returns the changed values and reports what changed', () => {
    const { policy, changed } = parsePolicy(
      JSON.stringify({ smlChildIdShort: 'forbid', iriBase: 'https://example.com/ids' }),
    );
    expect(policy.smlChildIdShort).toBe('forbid');
    expect(policy.iriBase).toBe('https://example.com/ids');
    expect(changed.sort()).toEqual(['iriBase', 'smlChildIdShort']);
  });

  it('a value equal to the default is not counted as "changed"', () => {
    const { changed } = parsePolicy(JSON.stringify({ smlChildIdShort: DEFAULT_POLICY.smlChildIdShort }));
    expect(changed).toEqual([]);
  });

  it('Important: an unknown key is an error — typos are not silently ignored', () => {
    expect(() => parsePolicy(JSON.stringify({ smlChildIdShrot: 'forbid' }))).toThrow(PolicyFileError);
    try {
      parsePolicy(JSON.stringify({ 아무거나: 1 }));
    } catch (error) {
      expect((error as Error).message).toContain('쓸 수 있는 것');
    }
  });

  it('Important: an invalid value is also an error — and the message lists the allowed values', () => {
    try {
      parsePolicy(JSON.stringify({ smlChildIdShort: 'strict' }));
      throw new Error('여기 오면 안 된다');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFileError);
      expect((error as Error).message).toContain('warn');
      expect((error as Error).message).toContain('forbid');
    }
  });

  it('checks the shape of lists and ranges too', () => {
    expect(() => parsePolicy(JSON.stringify({ requiredSubmodels: 'DigitalNameplate' }))).toThrow();
    expect(() => parsePolicy(JSON.stringify({ submodelCountRange: [8, 6] }))).toThrow(/최솟값/);
    expect(() => parsePolicy(JSON.stringify({ submodelCountRange: [6, 8, 10] }))).toThrow();
    expect(parsePolicy(JSON.stringify({ submodelCountRange: [4, 9] })).policy.submodelCountRange).toEqual([4, 9]);
  });

  it('gives the reason when the input is not JSON', () => {
    expect(() => parsePolicy('{ 이건 JSON이 아니다')).toThrow(PolicyFileError);
    expect(() => parsePolicy('[]')).toThrow(/객체 하나/);
  });

  it('keys starting with `_` are treated as comments (JSON has no comments)', () => {
    const { policy } = parsePolicy(
      JSON.stringify({ _설명: '2026-09 개정 반영', cdDefinition: 'allow-empty' }),
    );
    expect(policy.cdDefinition).toBe('allow-empty');
  });

  it('reports where each value came from — the UI shows it as-is', () => {
    const sources = policySources({ iriBase: 'https://example.com/ids' });
    expect(sources.find((entry) => entry.key === 'iriBase')?.from).toBe('policy-file');
    expect(sources.find((entry) => entry.key === 'requiredSubmodels')?.from).toBe('default');
  });
});
