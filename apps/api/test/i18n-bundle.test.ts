/**
 * 레퍼런스 번들 · 저장소 오류의 영어 — 영어 화면에서 내보낸 번들은 사람이 읽는 글이 영어로 나간다.
 *
 * 한국어로 남아도 되는 것은 둘뿐이다: **제출 묶음의 폴더·파일 이름**(규격 구조)과
 *    **AAS 파일 자체에서 온 값**(올린 파일 이름 · 연결 이름 · idShort). 그 밖의 한국어가 보이면 실패다.
 * 언어를 고르지 않은 요청(기본 한국어)은 예전과 같은 한국어가 나와야 한다.
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
 * 한국어가 남아도 되는 자리를 지운다 — 남은 한국어가 있으면 그것이 안 옮긴 글이다.
 * @param fromFile AAS 파일에서 온 값(올린 파일 이름 · 연결 이름 등). 시험이 넣은 값 그대로 적는다
 */
function stripAllowed(text: string, fromFile: string[]): string {
  let out = text;
  for (const value of fromFile) out = out.split(value).join('');
  return (
    out
      // 제출 묶음 폴더 · 그 안 파일 경로 — 00_공정구성/… · 05_샘플데이터/수집값_*.csv
      .replace(/0[0-6]_[^\s`|<>()]*/g, '')
      // 가이던스 파일 이름 — {설비 파일}_AAS활용가이던스
      .replace(/_AAS활용가이던스/g, '')
  );
}

const leftovers = (text: string, fromFile: string[]): string[] =>
  stripAllowed(text, fromFile)
    .split('\n')
    .filter((line) => HANGUL.test(line));

describe('레퍼런스 번들 — 영어 요청이면 사람이 읽는 글이 영어다', () => {
  let h: ReturnType<typeof harness>;
  let processId: string;

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    const machine = (await h.store.importPackage({ name: '01-롤포밍기-공34.aasx', package: fixture('01-롤포밍기-공34.aasx') })).id;
    const spr = (await h.store.importPackage({ name: '03-SPR장비-뿌80.aasx', package: fixture('03-SPR장비-뿌80.aasx') })).id;
    processId = (await h.call('POST', '/packages/new', { assetName: 'BodyJoiningLine', unit: 'composite' })).body.packageId;
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { group: true, name: 'JoiningProcess' });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machine, parentPath: ['JoiningProcess'], bulkCount: 2 });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: spr, parentPath: ['JoiningProcess'] });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      name: 'FuturePress',
      globalAssetId: 'https://www.smart-factory.kr/ids/asset/FuturePress/1/0',
    });
    // 실동작 증빙까지 실리게 — 호기를 복제해 가상 PLC 연결과 값을 쌓는다
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
   * 사람이 읽는 파일 — 이 영역(번들 · 증빙)이 쓰는 것. 사전 점검 결과서(린터 결과서)와
   * 연계 항목 CSV(린터가 만든다)는 린터 쪽 시험이 본다
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
  /** AAS 파일에서 온 값 — 올린 파일 이름과 수집 연결 이름 */
  const FROM_FILE = ['01-롤포밍기-공34.aasx', '03-SPR장비-뿌80.aasx', '01-롤포밍기-공34', '03-SPR장비-뿌80', '가상 PLC (시뮬레이션)'];

  it('영어 번들 — 폴더·파일 이름과 파일에서 온 값 말고는 한국어가 없다', async () => {
    const { text } = await unpack('en');
    for (const file of HUMAN_FILES) {
      let body = text(file);
      // 연계 확인사항의 지적 줄은 린터(bundleLinkage)가 쓴 문장이다 — 이 영역 밖이라 뺀다
      if (file.endsWith('연계_확인사항.md')) body = body.split('\n').filter((line) => !/^- [⚠ℹ] /.test(line)).join('\n');
      expect({ file, leftovers: leftovers(body, FROM_FILE) }).toEqual({ file, leftovers: [] });
    }
    const readme = text('README.md');
    expect(readme).toContain('— Reference bundle v1.0.0');
    expect(readme).toContain('- Category: Production optimization / quality management');
    expect(readme).toContain('## Operation evidence');
    expect(text('06_검증결과/수집기록.html')).toContain('<html lang="en">');
    expect(text('05_샘플데이터/수집값_RollFormingMachine_1.csv').startsWith('Time,Machine (type),Unit,')).toBe(true);
    // manifest의 사람용 메모도 영어
    const manifest = JSON.parse(text('bundle-manifest.json'));
    for (const note of manifest.notes as string[]) expect(HANGUL.test(note)).toBe(false);
    // 규격이 정한 값은 언어와 상관없이 그대로 — 분류 이름 · 증빙 수준 판정(시뮬레이션 → C)
    expect(manifest.bundle.category).toBe('생산최적화/품질관리');
    expect(manifest.bundle.evidenceLevel).toBe('C');
  });

  it('언어를 고르지 않으면 예전 한국어 그대로 — ko 요청과 같은 바이트', async () => {
    const plain = await unpack();
    const ko = await unpack('ko-KR,ko;q=0.9,en;q=0.8');
    const en = await unpack('en');
    for (const file of HUMAN_FILES) {
      // 만든 시각(초 단위)만 다를 수 있다 — 날짜·시각 숫자를 지우고 견준다
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

  it('화면용 분석의 증빙 수준 설명도 요청 언어로', async () => {
    const en = await h.call('GET', `/packages/${processId}/bundle/linkage`, undefined, 'en');
    expect(en.body.evidence.levels.C).toBe('Simulation — virtual PLC values');
    expect(en.body.evidence.suggested).toBe('C');
    const ko = await h.call('GET', `/packages/${processId}/bundle/linkage`);
    expect(ko.body.evidence.levels.C).toBe('시뮬레이션 — 가상 PLC 값');
  });

  it('번들 요청 오류도 영어로', async () => {
    const bad = await h.call('GET', `/packages/${processId}/bundle?code=XX`, undefined, 'en');
    expect(bad.status).toBe(400);
    expect(bad.body.messages[0].text).toBe('The bundle code must look like RB01.');
  });
});

describe('저장소 오류 — 영어 요청이면 영어로', () => {
  it('없는 패키지(NotFoundError)가 영어로 돌아온다', async () => {
    const h = harness();
    await h.store.init();
    const en = await h.call('DELETE', '/packages/pkg_missing', undefined, 'en');
    expect(en.status).toBe(404);
    expect(en.body.messages[0].text).toBe('Package pkg_missing not found.');
    const ko = await h.call('DELETE', '/packages/pkg_missing');
    expect(ko.body.messages[0].text).toBe('패키지 pkg_missing을(를) 찾을 수 없습니다.');
  });
});
