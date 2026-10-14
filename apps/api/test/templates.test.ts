import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { seedTemplates } from '../src/templates.js';

const GOLDEN_AASX = readFileSync(
  fileURLToPath(new URL('../../../tests/fixtures/01-롤포밍기-공34.aasx', import.meta.url)),
);

describe('template folder (AAS_TEMPLATES_DIR)', () => {
  it('uploads .aasx files in the folder, does not upload the same name twice, and records the reason for broken files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aas-templates-'));
    writeFileSync(join(dir, 'IDTA-02006-DigitalNameplate.aasx'), GOLDEN_AASX);
    writeFileSync(join(dir, 'broken.aasx'), new Uint8Array([1, 2, 3]));
    writeFileSync(join(dir, 'readme.txt'), 'not a package');
    mkdirSync(join(dir, 'sub.aasx')); // a folder is not a file

    const store = new InMemoryStore();
    const first = await seedTemplates(store, dir);
    expect(first.added).toEqual(['IDTA-02006-DigitalNameplate.aasx']);
    expect(first.failed.map((f) => f.name)).toEqual(['broken.aasx']);
    expect((await store.listPackages()).items.map((p) => p.name)).toEqual([
      'IDTA-02006-DigitalNameplate.aasx',
    ]);

    // As if restarted — already present, so skipped
    const second = await seedTemplates(store, dir);
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual(['IDTA-02006-DigitalNameplate.aasx']);
    expect((await store.listPackages()).items.length).toBe(1);
  });

  it('records a missing folder as a failure and the server still starts', async () => {
    const result = await seedTemplates(new InMemoryStore(), '/no/such/dir');
    expect(result.added).toEqual([]);
    expect(result.failed.length).toBe(1);
  });
});
