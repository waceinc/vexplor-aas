/**
 * Environment -> AAS V3.0 JSON.
 *
 * A lossless serializer paired with the parser. Preserves the key order of the input object
 * (to avoid unnecessary diffs when round-tripping golden files).
 */
import type { Environment } from '../types/environment.js';

export interface SerializeOptions {
  /** Number of indentation spaces. 0 outputs a single line. Default 2 */
  indent?: number;
}

export function serializeEnvironment(env: Environment, options: SerializeOptions = {}): string {
  const { indent = 2 } = options;
  return JSON.stringify(env, null, indent);
}

/**
 * Canonical form for semantic comparison.
 * Object keys are sorted when serializing, so two Environments that differ only in key order produce the same string.
 * Array order is meaningful in AAS (SubmodelElementList.orderRelevant), so arrays are not sorted.
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
