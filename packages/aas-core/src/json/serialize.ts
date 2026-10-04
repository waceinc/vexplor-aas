/**
 * Environment → AAS V3.0 JSON.
 *
 * 파서와 짝을 이루는 무손실 직렬화기. 입력 객체의 키 순서를 그대로 유지한다
 * (골든 파일 왕복 시 불필요한 diff를 만들지 않기 위함).
 */
import type { Environment } from '../types/environment.js';

export interface SerializeOptions {
  /** 들여쓰기 칸 수. 0이면 한 줄로 출력한다. 기본 2 */
  indent?: number;
}

export function serializeEnvironment(env: Environment, options: SerializeOptions = {}): string {
  const { indent = 2 } = options;
  return JSON.stringify(env, null, indent);
}

/**
 * 의미적 비교용 정규 형식.
 * 객체 키를 정렬해 직렬화하므로, 키 순서만 다른 두 Environment가 같은 문자열이 된다.
 * 배열 순서는 AAS에서 의미를 가지므로(SubmodelElementList.orderRelevant) 정렬하지 않는다.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
