/**
 * Edge contract `vexplor.edge/1` (docs/edge-contract.md): the published schemas, the examples next to them, and the
 * signing example in the document must agree. Other products (VEXPLOR Logic Studio) implement the server side from these
 * files, so a drift here is a broken contract, not a typo.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { checkSchema, type JsonSchema } from '../src/integration/schema-check.js';

const DIR = 'docs/edge';
const schema = (name: string): JsonSchema => JSON.parse(readFileSync(`${DIR}/schemas/${name}.schema.json`, 'utf8')) as JsonSchema;
const example = (name: string): Record<string, unknown> => JSON.parse(readFileSync(`${DIR}/examples/${name}.json`, 'utf8')) as Record<string, unknown>;

/** Every example and the schema it shows */
const EXAMPLES: Record<string, string> = {
  'register-request': 'register-request',
  registration: 'registration',
  'read-list-pending': 'read-list',
  'read-list-approved': 'read-list',
  batch: 'batch',
  'signed-batch.body': 'batch',
  'batch-result': 'batch-result',
  'error-rate-limited': 'error',
};

describe('edge contract schemas and examples', () => {
  it('pairs every example file with a schema, and every schema with at least one example', () => {
    const examples = readdirSync(`${DIR}/examples`).map((file) => file.replace(/\.json$/, '')).sort();
    expect(examples).toEqual(Object.keys(EXAMPLES).sort());
    const schemas = readdirSync(`${DIR}/schemas`).map((file) => file.replace(/\.schema\.json$/, '')).sort();
    expect(schemas).toEqual([...new Set(Object.values(EXAMPLES))].sort());
  });

  it.each(Object.entries(EXAMPLES))('%s validates against %s', (name, target) => {
    expect(checkSchema(schema(target), example(name))).toEqual([]);
  });

  it('refuses what the contract refuses', () => {
    const { seq: _seq, ...noSeq } = example('batch');
    expect(checkSchema(schema('batch'), noSeq)).not.toEqual([]);
    expect(checkSchema(schema('batch'), { ...example('batch'), seq: 0 })).not.toEqual([]);
    const pending = example('read-list-pending');
    expect(checkSchema(schema('read-list'), { ...pending, state: 'running' })).not.toEqual([]);
    expect(checkSchema(schema('error'), { ...example('error-rate-limited'), code: 'Teapot' })).not.toEqual([]);
  });
});

describe('edge contract signing example', () => {
  const full = readFileSync('docs/edge-contract.md', 'utf8');
  // Only the worked example — the header table above it names the same headers with placeholder values
  const doc = full.slice(full.indexOf('**Worked example**'), full.indexOf('## 3.'));
  /** A value from the worked-example table: | <label> | `<value>` | */
  const cell = (label: string): string => {
    const match = new RegExp(`\\| ${label}[^|]*\\| \`([^\`]+)\``).exec(doc);
    if (!match) throw new Error(`no ${label} in the worked example`);
    return match[1]!;
  };

  it('the body hash, the public key and the signature in the document verify', () => {
    const body = readFileSync(`${DIR}/examples/signed-batch.body.json`);
    const bodyHash = createHash('sha256').update(body).digest('hex');
    expect(bodyHash).toBe(cell('Body SHA-256'));

    const request = /`POST (\S+)`, device `([^`]+)`, timestamp `(\d+)`, nonce `([^`]+)`/.exec(doc)!;
    const [, path, device, timestamp, nonce] = request;
    const signed = ['vexplor.edge/1', 'POST', path, timestamp, nonce, device, bodyHash].join('\n');

    const raw = Buffer.from(cell('Public key \\(base64url\\)'), 'base64url');
    // SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410) followed by the 32 raw bytes
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    const signature = Buffer.from(cell('`X-Edge-Signature`').replace(/^ed25519=/, ''), 'base64url');
    expect(verify(null, Buffer.from(signed), key, signature)).toBe(true);
    // One changed byte of the signed text must fail — the check is not vacuous
    expect(verify(null, Buffer.from(signed.replace('POST', 'PUT')), key, signature)).toBe(false);
  });

  it('the key is the RFC 8032 test key, never a real one', () => {
    expect(Buffer.from(cell('Public key \\(base64url\\)'), 'base64url').toString('hex')).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
  });
});
