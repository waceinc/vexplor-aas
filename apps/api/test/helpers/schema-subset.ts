/**
 * Minimal checker for the JSON Schema subset the export schemas use (type / type arrays, properties, required, enum,
 * items, additionalProperties: false). Written independently of WP3's `schema-check.ts` so WP4 can test before it
 * lands; once merged, `integration-schemas.test.ts` validates the same schemas with the shared checker.
 */
type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function schemaErrors(schema: Schema, value: unknown, path = ''): string[] {
  const errors: string[] = [];
  const at = path || '/';
  if (schema['enum'] !== undefined && !(schema['enum'] as unknown[]).some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: not in enum`);
  }
  if (schema['type'] !== undefined) {
    const allowed = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...errors, `${at}: expected ${allowed.join('|')}, got ${actual}`];
    }
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const key of (schema['required'] ?? []) as string[]) if (!(key in record)) errors.push(`${path}/${key}: required`);
    for (const [key, item] of Object.entries(record)) {
      if (properties[key]) errors.push(...schemaErrors(properties[key], item, `${path}/${key}`));
      else if (schema['additionalProperties'] === false) errors.push(`${path}/${key}: not allowed`);
    }
  }
  if (Array.isArray(value) && schema['items']) {
    value.forEach((item, i) => errors.push(...schemaErrors(schema['items'] as Schema, item, `${path}/${i}`)));
  }
  return errors;
}
