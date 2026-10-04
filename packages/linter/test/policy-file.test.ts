/**
 * 정책 파일 — 규약이 바뀔 때 코드를 고치지 않고 값을 바꾸는 길.
 *
 * 🔴 이 시험의 절반은 **틀린 파일을 받아 주지 않는가**이다.
 *    오타가 조용히 무시되면 "바꿨는데 안 바뀌었다"가 되고, 그 상태로 제출까지 간다.
 */
import { DEFAULT_POLICY, parsePolicy, policySources, PolicyFileError } from '@aas/linter';
import { describe, expect, it } from 'vitest';

describe('정책 파일 읽기', () => {
  it('바꾼 값을 돌려주고 무엇이 바뀌었는지 알려 준다', () => {
    const { policy, changed } = parsePolicy(
      JSON.stringify({ smlChildIdShort: 'forbid', iriBase: 'https://example.com/ids' }),
    );
    expect(policy.smlChildIdShort).toBe('forbid');
    expect(policy.iriBase).toBe('https://example.com/ids');
    expect(changed.sort()).toEqual(['iriBase', 'smlChildIdShort']);
  });

  it('기본값과 같은 값은 「바뀐 것」으로 세지 않는다', () => {
    const { changed } = parsePolicy(JSON.stringify({ smlChildIdShort: DEFAULT_POLICY.smlChildIdShort }));
    expect(changed).toEqual([]);
  });

  it('🔴 모르는 항목은 오류 — 오타를 조용히 넘기지 않는다', () => {
    expect(() => parsePolicy(JSON.stringify({ smlChildIdShrot: 'forbid' }))).toThrow(PolicyFileError);
    try {
      parsePolicy(JSON.stringify({ 아무거나: 1 }));
    } catch (error) {
      expect((error as Error).message).toContain('쓸 수 있는 것');
    }
  });

  it('🔴 쓸 수 없는 값도 오류 — 무엇을 쓸 수 있는지 함께 말한다', () => {
    try {
      parsePolicy(JSON.stringify({ smlChildIdShort: 'strict' }));
      throw new Error('여기 오면 안 된다');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFileError);
      expect((error as Error).message).toContain('warn');
      expect((error as Error).message).toContain('forbid');
    }
  });

  it('목록·범위도 모양을 본다', () => {
    expect(() => parsePolicy(JSON.stringify({ requiredSubmodels: 'DigitalNameplate' }))).toThrow();
    expect(() => parsePolicy(JSON.stringify({ submodelCountRange: [8, 6] }))).toThrow(/최솟값/);
    expect(() => parsePolicy(JSON.stringify({ submodelCountRange: [6, 8, 10] }))).toThrow();
    expect(parsePolicy(JSON.stringify({ submodelCountRange: [4, 9] })).policy.submodelCountRange).toEqual([4, 9]);
  });

  it('JSON이 아니면 사유를 말한다', () => {
    expect(() => parsePolicy('{ 이건 JSON이 아니다')).toThrow(PolicyFileError);
    expect(() => parsePolicy('[]')).toThrow(/객체 하나/);
  });

  it('`_`로 시작하는 키는 주석 자리로 넘어간다 (JSON에는 주석이 없다)', () => {
    const { policy } = parsePolicy(
      JSON.stringify({ _설명: '2026-09 개정 반영', cdDefinition: 'allow-empty' }),
    );
    expect(policy.cdDefinition).toBe('allow-empty');
  });

  it('값이 어디서 왔는지 알려 준다 — 화면이 그대로 보여 준다', () => {
    const sources = policySources({ iriBase: 'https://example.com/ids' });
    expect(sources.find((entry) => entry.key === 'iriBase')?.from).toBe('정책 파일');
    expect(sources.find((entry) => entry.key === 'requiredSubmodels')?.from).toBe('기본값');
  });
});
