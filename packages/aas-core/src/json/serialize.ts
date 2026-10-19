/**
 * Environment -> AAS JSON.
 *
 * A lossless serializer paired with the parser. Preserves the key order of the input object
 * (to avoid unnecessary diffs when round-tripping golden files).
 *
 * Two entry points:
 *  - {@link serializeEnvironment} writes the model exactly as held — no version handling. Internal round trips
 *    (store snapshots, sameness checks) rely on it never changing content.
 *  - {@link writeEnvironment} writes a chosen metamodel version (default 3.0) and reports what that version could not
 *    hold. Use it wherever a file leaves for someone else.
 */
import type { Environment } from '../types/environment.js';
import { convertEnvironment, type ConvertOptions, type DowngradeReport } from '../metamodel/convert.js';
import type { MetamodelVersion } from '../metamodel/versions.js';

export interface SerializeOptions {
  /** Number of indentation spaces. 0 outputs a single line. Default 2 */
  indent?: number;
}

export function serializeEnvironment(env: Environment, options: SerializeOptions = {}): string {
  const { indent = 2 } = options;
  return JSON.stringify(env, null, indent);
}

export interface WriteEnvironmentOptions extends SerializeOptions {
  /** Metamodel version to write. Default 3.0 (DEFAULT_METAMODEL_VERSION) */
  version?: MetamodelVersion;
  /** See {@link ConvertOptions.unrepresentable}. Default `error` */
  unrepresentable?: ConvertOptions['unrepresentable'];
}

/**
 * Writes the model as the chosen version.
 * Important: for a model that already fits the version the text is exactly {@link serializeEnvironment}'s — no clone,
 *    no reordering — so choosing 3.0 explicitly cannot change a 3.0 file by a single byte.
 * @throws DowngradeError when the version cannot express a value and `unrepresentable` is not `keep`
 */
export function writeEnvironment(
  env: Environment,
  options: WriteEnvironmentOptions = {},
): { text: string; report: DowngradeReport } {
  const convertOptions: ConvertOptions = {};
  if (options.version !== undefined) convertOptions.to = options.version;
  if (options.unrepresentable !== undefined) convertOptions.unrepresentable = options.unrepresentable;
  const { environment, report } = convertEnvironment(env, convertOptions);
  const serializeOptions: SerializeOptions = {};
  if (options.indent !== undefined) serializeOptions.indent = options.indent;
  return { text: serializeEnvironment(environment, serializeOptions), report };
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
