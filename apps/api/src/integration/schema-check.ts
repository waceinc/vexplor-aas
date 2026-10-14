/**
 * A small JSON Schema validator for the subset our event schemas use (docs/design/integration-v1.md §2.5):
 * `type` (string or list, `"null"` for nullable), `properties`, `required`, `enum`, `const`, `items`,
 * `additionalProperties` (boolean or schema), `$ref` to `#/$defs/<name>`, `anyOf`, `minimum`.
 *
 * Why in-repo: the schemas are part of our contract and a CI test validates every produced event against them;
 * a dependency for ~100 lines of checking is a licence review and a supply-chain risk for nothing.
 * Anything outside the subset is an error in the schema itself — reported, never silently ignored.
 */

export type JsonSchema = {
  $id?: string;
  $schema?: string;
  title?: string;
  description?: string;
  type?: SchemaType | SchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  minimum?: number;
};

export type SchemaType = 'null' | 'boolean' | 'object' | 'array' | 'number' | 'integer' | 'string';

export interface SchemaError {
  /** JSON Pointer into the checked value */
  path: string;
  message: string;
}

const KNOWN_KEYWORDS = new Set([
  '$id', '$schema', 'title', 'description', 'type', 'properties', 'required', 'enum', 'const', 'items',
  'additionalProperties', '$ref', '$defs', 'anyOf', 'minimum',
]);

function typeOf(value: unknown): SchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as SchemaType;
}

function typeAccepts(wanted: SchemaType, actual: SchemaType): boolean {
  return wanted === actual || (wanted === 'number' && actual === 'integer');
}

const pointer = (path: string, key: string | number): string => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** Validates `value` against `schema`; an empty list means valid */
export function checkSchema(schema: JsonSchema, value: unknown, root: JsonSchema = schema, path = ''): SchemaError[] {
  const errors: SchemaError[] = [];
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) errors.push({ path, message: `schema uses unsupported keyword "${keyword}"` });
  }
  if (schema.$ref !== undefined) {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    const target = name === undefined ? undefined : root.$defs?.[name];
    if (!target) return [...errors, { path, message: `unresolvable $ref ${schema.$ref}` }];
    return [...errors, ...checkSchema(target, value, root, path)];
  }
  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((branch) => checkSchema(branch, value, root, path));
    if (!branches.some((branch) => branch.length === 0)) {
      errors.push({ path, message: `matches none of ${schema.anyOf.length} alternatives (${branches.map((b) => b[0]?.message).join(' | ')})` });
    }
  }
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((type) => typeAccepts(type, actual))) {
      return [...errors, { path, message: `expected ${wanted.join(' | ')}, got ${actual}` }];
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push({ path, message: `not one of ${JSON.stringify(schema.enum)}` });
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push({ path, message: `below minimum ${schema.minimum}` });
  }
  if (actual === 'array' && schema.items !== undefined) {
    (value as unknown[]).forEach((item, index) => errors.push(...checkSchema(schema.items!, item, root, pointer(path, index))));
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push({ path, message: `missing required "${key}"` });
    }
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...checkSchema(property, item, root, pointer(path, key)));
      else if (schema.additionalProperties === false) errors.push({ path, message: `unexpected property "${key}"` });
      else if (typeof schema.additionalProperties === 'object') {
        errors.push(...checkSchema(schema.additionalProperties, item, root, pointer(path, key)));
      }
    }
  }
  return errors;
}
