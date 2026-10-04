/**
 * 정책 파일 — **규약이 바뀌면 코드를 고치지 않고 여기를 고친다.**
 *
 * 규칙(로직)과 규약(값)은 성격이 다르다.
 *  - **규칙**은 로직이라 코드가 맞다(새 규칙이 생기면 함수를 짓는다)
 *  - **규약**은 값이다 — 회사 IRI 뿌리, 필수 서브모델 목록, 규정 충돌에서 무엇을 고를지.
 *    이런 것이 바뀔 때마다 코드를 고치고 다시 배포하면, 현장에서 못 바꾼다.
 *
 * 🔴 **모르는 키와 잘못된 값은 오류로 멈춘다.** 정책 파일의 오타가 조용히 무시되면
 *    "바꿨는데 안 바뀌었다"가 되고, 그 상태로 제출까지 간다. 그게 최악이다.
 */
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';

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
  /** 기본값에서 실제로 달라진 항목 */
  changed: (keyof LinterPolicy)[];
}

/** 정책 파일(JSON)을 읽어 확인한다. 틀리면 사유를 말하고 멈춘다 */
export function parsePolicy(text: string): ParsedPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PolicyFileError(`정책 파일이 JSON이 아닙니다: ${String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyFileError('정책 파일은 객체 하나여야 합니다.');
  }

  const known = new Set(Object.keys(DEFAULT_POLICY));
  const policy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // 주석 자리 — `_`로 시작하는 키는 그냥 넘어간다(JSON에는 주석이 없다)
    if (key.startsWith('_')) continue;
    if (!known.has(key)) {
      throw new PolicyFileError(
        `모르는 정책 항목입니다: ${key} — 쓸 수 있는 것: ${[...known].join(', ')}`,
      );
    }

    const enumValues = ENUMS[key as keyof LinterPolicy];
    if (enumValues) {
      if (typeof value !== 'string' || !enumValues.includes(value)) {
        throw new PolicyFileError(
          `${key}에 쓸 수 없는 값입니다: ${JSON.stringify(value)} — 쓸 수 있는 것: ${enumValues.join(' · ')}`,
        );
      }
      policy[key] = value;
      continue;
    }

    if (STRING_KEYS.includes(key as keyof LinterPolicy)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new PolicyFileError(`${key}는 비어 있지 않은 글자여야 합니다.`);
      }
      policy[key] = value;
      continue;
    }

    if (STRING_ARRAY_KEYS.includes(key as keyof LinterPolicy)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new PolicyFileError(`${key}는 글자 목록이어야 합니다.`);
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
        throw new PolicyFileError('submodelCountRange는 정수 두 개여야 합니다. 예: [6, 8]');
      }
      if ((range[0] as number) > (range[1] as number)) {
        throw new PolicyFileError('submodelCountRange의 최솟값이 최댓값보다 큽니다.');
      }
      policy[key] = range;
      continue;
    }

    throw new PolicyFileError(`아직 정책 파일로 바꿀 수 없는 항목입니다: ${key}`);
  }

  const changed = (Object.keys(policy) as (keyof LinterPolicy)[]).filter(
    (key) => JSON.stringify(policy[key]) !== JSON.stringify(DEFAULT_POLICY[key]),
  );
  return { policy: policy as Partial<LinterPolicy>, changed };
}

/** 지금 쓰이는 값이 어디서 왔는지 — 규칙 화면이 보여 준다 */
export function policySources(
  policy: Partial<LinterPolicy>,
): { key: keyof LinterPolicy; from: '기본값' | '정책 파일' }[] {
  return (Object.keys(DEFAULT_POLICY) as (keyof LinterPolicy)[]).map((key) => ({
    key,
    from:
      key in policy && JSON.stringify(policy[key]) !== JSON.stringify(DEFAULT_POLICY[key])
        ? '정책 파일'
        : '기본값',
  }));
}
