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

describe('템플릿 폴더 (AAS_TEMPLATES_DIR)', () => {
  it('폴더의 .aasx를 올리고, 같은 이름은 두 번 올리지 않고, 깨진 파일은 이유를 남긴다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aas-templates-'));
    writeFileSync(join(dir, 'IDTA-02006-DigitalNameplate.aasx'), GOLDEN_AASX);
    writeFileSync(join(dir, 'broken.aasx'), new Uint8Array([1, 2, 3]));
    writeFileSync(join(dir, 'readme.txt'), 'not a package');
    mkdirSync(join(dir, 'sub.aasx')); // 폴더는 파일이 아니다

    const store = new InMemoryStore();
    const first = await seedTemplates(store, dir);
    expect(first.added).toEqual(['IDTA-02006-DigitalNameplate.aasx']);
    expect(first.failed.map((f) => f.name)).toEqual(['broken.aasx']);
    expect((await store.listPackages()).items.map((p) => p.name)).toEqual([
      'IDTA-02006-DigitalNameplate.aasx',
    ]);

    // 다시 기동한 셈 — 이미 있으니 건너뛴다
    const second = await seedTemplates(store, dir);
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual(['IDTA-02006-DigitalNameplate.aasx']);
    expect((await store.listPackages()).items.length).toBe(1);
  });

  it('없는 폴더면 실패로 적고 서버는 뜬다', async () => {
    const result = await seedTemplates(new InMemoryStore(), '/no/such/dir');
    expect(result.added).toEqual([]);
    expect(result.failed.length).toBe(1);
  });
});
