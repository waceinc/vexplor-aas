/**
 * English for the reference bundle and store errors — a bundle exported from the English UI ships human-readable text in English.
 *
 * Only two things may remain Korean: **folder and file names in the submission package** (the spec structure) and
 *    **values that come from the AAS file itself** (uploaded file name, connection name, idShort). Any other Korean is a failure.
 * A request with no language chosen (Korean by default) must produce the same Korean as before.
 */
import { readAasx, unzipArchive } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

const fixture = (name: string) => readAasx(new Uint8Array(readFileSync(`tests/fixtures/${name}`)));
const HANGUL = /[가-힣]/;

/* eslint-disable @typescript-eslint/no-explicit-any */
function harness(store = new InMemoryStore()) {
  const handle = createApi(store);
  const call = async (
    method: string,
    rawPath: string,
    body?: unknown,
    lang?: string,
  ): Promise<{ status: number; body: any }> => {
    const [path, queryText] = rawPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(queryText ?? ''));
    const headers: Record<string, string> = body ? { 'content-type': 'application/json' } : {};
    if (lang) headers['accept-language'] = lang;
    const response = await handle({
      method,
      path,
      query,
      queryAll: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]])),
      headers,
      ...(body ? { body } : {}),
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };
  return { store, call };
}

/**
 * Removes the places where Korean is allowed to remain — any Korean left over is untranslated text.
 * @param fromFile Values from the AAS file (uploaded file name, connection name, etc.). Write them exactly as the test inserted them
 */
function stripAllowed(text: string, fromFile: string[]): string {
  let out = text;
  for (const value of fromFile) out = out.split(value).join('');
  return (
    out
      // Submission package folders and file paths inside them — 00_공정구성/… · 05_샘플데이터/수집값_*.csv
      .replace(/0[0-6]_[^\s`|<>()]*/g, '')
      // Guidance file name — {equipment file}_AAS활용가이던스
      .replace(/_AAS활용가이던스/g, '')
  );
}

const leftovers = (text: string, fromFile: string[]): string[] =>
  stripAllowed(text, fromFile)
    .split('\n')
    .filter((line) => HANGUL.test(line));

describe('reference bundle — an English request gives human-readable text in English', () => {
  let h: ReturnType<typeof harness>;
  let processId: string;

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    const machine = (await h.store.importPackage({ name: '01-roll-forming-machine.aasx', package: fixture('01-roll-forming-machine.aasx') })).id;
    const spr = (await h.store.importPackage({ name: '03-spr-riveting-machine.aasx', package: fixture('03-spr-riveting-machine.aasx') })).id;
    processId = (await h.call('POST', '/packages/new', { assetName: 'BodyJoiningLine', unit: 'composite' })).body.packageId;
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { group: true, name: 'JoiningProcess' });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machine, parentPath: ['JoiningProcess'], bulkCount: 2 });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: spr, parentPath: ['JoiningProcess'] });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      name: 'FuturePress',
      globalAssetId: 'https://www.smart-factory.kr/ids/asset/FuturePress/1/0',
    });
    // So that live-operation evidence is included too — clone a unit and accumulate a virtual PLC connection and values
    const unit = (await h.call('POST', `/packages/${machine}/clone`, { assetName: 'RollFormingMachine_1' })).body.packageId;
    await h.call('POST', `/packages/${unit}/aid`, {
      endpoint: 'opc.tcp://127.0.0.1:14850/UA/Simulator',
      title: '가상 PLC (시뮬레이션)',
      tags: [{ name: 'MachineState', href: 'ns=1;s=RollFormingMachine_1.MachineState', type: 'string' }],
    });
    const t0 = Date.parse('2026-09-30T03:00:00Z');
    await h.store.appendValues(
      unit,
      Array.from({ length: 6 }, (_, i) => ({
        packageId: unit,
        interfaceName: 'InterfaceTemplateForOPCUA',
        propertyName: 'MachineState',
        source: 'ns=1;s=RollFormingMachine_1.MachineState',
        observedAt: new Date(t0 + i * 5000).toISOString(),
        valueText: 'RUNNING',
        quality: 'Good',
      })),
    );
  });

  const unpack = async (lang?: string) => {
    const response = await h.call('GET', `/packages/${processId}/bundle?code=RB01`, undefined, lang);
    expect(response.status).toBe(200);
    const entries = unzipArchive(response.body as Uint8Array);
    const text = (suffix: string): string => {
      const found = Object.entries(entries).find(([p]) => p.endsWith(suffix));
      if (!found) throw new Error(`번들에 없습니다: ${suffix}`);
      return new TextDecoder().decode(found[1]);
    };
    return { entries, text };
  };

  /**
   * Human-readable files — the ones this area (bundle, evidence) writes. The pre-check report (linter report) and
   * the linkage item CSV (made by the linter) are covered by the linter-side tests
   */
  const HUMAN_FILES = [
    'README.md',
    '04_데이터연계정의/연계_확인사항.md',
    '01_UseCase문서/_작성안내.md',
    '03_가이던스/_작성안내.md',
    '05_샘플데이터/_작성안내.md',
    '06_검증결과/수집기록.html',
    '05_샘플데이터/수집값_RollFormingMachine_1.csv',
  ];
  /** Values from the AAS file — the uploaded file name and the collection connection name */
  const FROM_FILE = ['01-roll-forming-machine.aasx', '03-spr-riveting-machine.aasx', '01-roll-forming-machine', '03-spr-riveting-machine', '가상 PLC (시뮬레이션)'];

  it('English bundle — no Korean except folder/file names and values from the file', async () => {
    const { text } = await unpack('en');
    for (const file of HUMAN_FILES) {
      let body = text(file);
      // Finding lines in the linkage checklist are sentences written by the linter (bundleLinkage) — outside this area, so excluded
      if (file.endsWith('연계_확인사항.md')) body = body.split('\n').filter((line) => !/^- [⚠ℹ] /.test(line)).join('\n');
      expect({ file, leftovers: leftovers(body, FROM_FILE) }).toEqual({ file, leftovers: [] });
    }
    const readme = text('README.md');
    expect(readme).toContain('— Reference bundle v1.0.0');
    expect(readme).toContain('- Category: Production optimization / quality management');
    expect(readme).toContain('## Operation evidence');
    expect(text('06_검증결과/수집기록.html')).toContain('<html lang="en">');
    expect(text('05_샘플데이터/수집값_RollFormingMachine_1.csv').startsWith('Time,Machine (type),Unit,')).toBe(true);
    // The human-facing notes in the manifest are English too
    const manifest = JSON.parse(text('bundle-manifest.json'));
    for (const note of manifest.notes as string[]) expect(HANGUL.test(note)).toBe(false);
    // Values defined by the spec stay as is regardless of language — category names, evidence level verdict (simulation -> C)
    expect(manifest.bundle.category).toBe('생산최적화/품질관리');
    expect(manifest.bundle.evidenceLevel).toBe('C');
  });

  it('with no language chosen, the same Korean as before — byte-identical to a ko request', async () => {
    const plain = await unpack();
    const ko = await unpack('ko-KR,ko;q=0.9,en;q=0.8');
    const en = await unpack('en');
    for (const file of HUMAN_FILES) {
      // Only the creation time (in seconds) may differ — strip date/time digits before comparing
      const clean = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<t>');
      expect(clean(ko.text(file))).toBe(clean(plain.text(file)));
      expect(clean(en.text(file))).not.toBe(clean(plain.text(file)));
    }
    const readme = plain.text('README.md');
    expect(readme).toContain('# RB01 생산최적화/품질관리 — 레퍼런스 번들 v1.0.0');
    expect(readme).toContain('- 카테고리: 생산최적화/품질관리');
    expect(readme).toContain('## 실동작 증빙');
    expect(plain.text('06_검증결과/수집기록.html')).toContain('<html lang="ko">');
    expect(plain.text('05_샘플데이터/수집값_RollFormingMachine_1.csv').startsWith('시각,설비(형식),호기,')).toBe(true);
  });

  it('the evidence level description in the UI analysis is in the request language too', async () => {
    const en = await h.call('GET', `/packages/${processId}/bundle/linkage`, undefined, 'en');
    expect(en.body.evidence.levels.C).toBe('Simulation — virtual PLC values');
    expect(en.body.evidence.suggested).toBe('C');
    const ko = await h.call('GET', `/packages/${processId}/bundle/linkage`);
    expect(ko.body.evidence.levels.C).toBe('시뮬레이션 — 가상 PLC 값');
  });

  it('bundle request errors are in English too', async () => {
    const bad = await h.call('GET', `/packages/${processId}/bundle?code=XX`, undefined, 'en');
    expect(bad.status).toBe(400);
    expect(bad.body.messages[0].text).toBe('The bundle code must look like RB01.');
  });
});

describe('store errors — in English for an English request', () => {
  it('an unknown package (NotFoundError) comes back in English', async () => {
    const h = harness();
    await h.store.init();
    const en = await h.call('DELETE', '/packages/pkg_missing', undefined, 'en');
    expect(en.status).toBe(404);
    expect(en.body.messages[0].text).toBe('Package pkg_missing not found.');
    const ko = await h.call('DELETE', '/packages/pkg_missing');
    expect(ko.body.messages[0].text).toBe('패키지 pkg_missing을(를) 찾을 수 없습니다.');
  });
});
