/**
 * 레퍼런스 번들 — 공정 파일 하나를 제출 꾸러미로 내보내고 다시 연다.
 *
 * 🔴 이 시험의 요점: **번들에 든 모델이 지금 열린 모델과 같은 내용인가를 해시가 말해 주는가.**
 * 「모델은 바뀌었는데 번들에는 옛 판이 남는」 사고를 막는 유일한 장치다.
 */
import { readAasx, unzipArchive, zipArchive } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

const fixture = (name: string) => readAasx(new Uint8Array(readFileSync(`tests/fixtures/${name}`)));
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/* eslint-disable @typescript-eslint/no-explicit-any */
function harness(store = new InMemoryStore()) {
  const handle = createApi(store);
  /** 로그인한 채로 부르고 싶을 때 — 감사 기록(누가 내보냈나)을 보는 시험이 쓴다 */
  let cookie: string | undefined;
  const call = async (
    method: string,
    rawPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: any; headers: Record<string, string> }> => {
    const [path, queryText] = rawPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(queryText ?? ''));
    const binary = body instanceof Uint8Array;
    const headers: Record<string, string> = body
      ? { 'content-type': binary ? 'application/zip' : 'application/json' }
      : {};
    if (cookie) headers['cookie'] = cookie;
    const response = await handle({
      method,
      path,
      query,
      queryAll: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]])),
      headers,
      ...(body ? { body } : {}),
    } as ApiRequest);
    return { status: response.status, body: response.body as any, headers: (response.headers ?? {}) as Record<string, string> };
  };
  const loginAs = async (displayName: string): Promise<void> => {
    const made = await call('POST', '/auth/setup', {
      login: 'tester',
      displayName,
      password: '열자가넘는비밀번호입니다',
    });
    cookie = (made.headers['set-cookie'] ?? '').split(';')[0];
  };
  return { store, call, loginAs };
}

describe('레퍼런스 번들', () => {
  let h: ReturnType<typeof harness>;
  let processId: string;
  let machineId: string;

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    machineId = (await h.store.importPackage({ name: '01-롤포밍기-공34.aasx', package: fixture('01-롤포밍기-공34.aasx') })).id;
    const spr = (await h.store.importPackage({ name: '03-SPR장비-뿌80.aasx', package: fixture('03-SPR장비-뿌80.aasx') })).id;
    processId = (await h.call('POST', '/packages/new', { assetName: 'BodyJoiningLine', unit: 'composite' })).body.packageId;
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { group: true, name: 'JoiningProcess' });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machineId, parentPath: ['JoiningProcess'], bulkCount: 2 });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: spr, parentPath: ['JoiningProcess'] });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      name: 'FuturePress',
      globalAssetId: 'https://www.smart-factory.kr/ids/asset/FuturePress/1/0',
    });
  });

  it('🔴 누가 내보냈는지 남는다 — 제출 꾸러미라 물어볼 사람이 적혀 있어야 한다', async () => {
    await h.loginAs('품질팀 홍길동');
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const entries = unzipArchive(zip);
    const text = (suffix: string) =>
      new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith(suffix))![1]);
    expect(JSON.parse(text('bundle-manifest.json')).bundle.createdBy).toBe('품질팀 홍길동');
    expect(text('README.md')).toContain('내보낸 사람: 품질팀 홍길동');
  });

  it('로그인을 쓰지 않는 서버는 비워 둔다 — 모르는 것을 아는 척하지 않는다', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const entries = unzipArchive(zip);
    const text = (suffix: string) =>
      new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith(suffix))![1]);
    expect(JSON.parse(text('bundle-manifest.json')).bundle.createdBy).toBeNull();
    expect(text('README.md')).not.toContain('내보낸 사람');
  });

  it('연계 분석 — 설비 준비 상태와 공통 항목을 준다', async () => {
    const res = await h.call('GET', `/packages/${processId}/bundle/linkage`);
    expect(res.status).toBe(200);
    const names = res.body.members.map((m: any) => m.name);
    expect(names).toEqual(['RollFormingMachine', 'SPREquipment', 'FuturePress']);
    const machine = res.body.members.find((m: any) => m.name === 'RollFormingMachine');
    expect(machine.groupPath).toEqual(['JoiningProcess']);
    expect(machine.bulkCount).toBe(2);
    expect(machine.lint.error).toBe(0);
    const planned = res.body.members.find((m: any) => m.name === 'FuturePress');
    expect(planned.packageId).toBeUndefined();
    expect(res.body.linkage.missing).toEqual(['FuturePress']);
    // 두 설비가 함께 가진 운전 데이터 항목이 있어야 번들이 성립한다
    expect(res.body.linkage.items.some((i: any) => i.coverage === 2)).toBe(true);
  });

  it('🔴 수집 연결(AID)을 붙인 설비는 시연본으로 드러난다 — 제출본과 섞이지 않게', async () => {
    const before = await h.call('GET', `/packages/${processId}/bundle/linkage`);
    expect(before.body.members.some((m: any) => m.demo)).toBe(false);

    const aid = await h.call('POST', `/packages/${machineId}/aid`, {
      endpoint: 'opc.tcp://127.0.0.1:14850/UA/Simulator',
      title: '가상 PLC (시뮬레이션)',
      tags: [{ name: 'MachineState', href: 'ns=1;s=RollFormingMachine.MachineState', type: 'string' }],
    });
    expect(aid.status).toBe(201);

    const after = await h.call('GET', `/packages/${processId}/bundle/linkage`);
    expect(after.body.members.find((m: any) => m.name === 'RollFormingMachine').demo).toBe(true);
    expect(after.body.members.find((m: any) => m.name === 'SPREquipment').demo).toBeUndefined();

    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const entries = unzipArchive(zip);
    const text = (suffix: string) =>
      new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith(suffix))![1]);
    const manifest = JSON.parse(text('bundle-manifest.json'));
    expect(manifest.models.find((m: any) => m.assetName === 'RollFormingMachine').demo).toBe(true);
    expect(text('README.md')).toContain('시연본 포함');
  });

  describe('실동작 증빙 — 시연을 대신하는 수집 기록', () => {
    /** 형식(롤포밍기)에서 호기를 복제하고, 그 호기에 수집 연결과 값을 쌓는다 */
    const collectOnUnit = async (endpoint: string, title: string) => {
      const unit = (await h.call('POST', `/packages/${machineId}/clone`, { assetName: 'RollFormingMachine_1' })).body.packageId;
      await h.call('POST', `/packages/${unit}/aid`, {
        endpoint,
        title,
        tags: [{ name: 'MachineState', href: 'ns=1;s=RollFormingMachine_1.MachineState', type: 'string' }],
      });
      const t0 = Date.parse('2026-09-30T03:00:00Z');
      await h.store.appendValues(
        unit,
        Array.from({ length: 10 }, (_, i) => ({
          packageId: unit,
          interfaceName: 'InterfaceTemplateForOPCUA',
          propertyName: 'MachineState',
          source: 'ns=1;s=RollFormingMachine_1.MachineState',
          observedAt: new Date(t0 + i * 5000).toISOString(),
          valueText: i === 3 ? 'ALARM' : 'RUNNING',
          quality: 'Good',
        })),
      );
      return unit;
    };
    const unpack = async (query: string) => {
      const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01${query}`)).body as Uint8Array;
      const entries = unzipArchive(zip);
      const find = (suffix: string) => Object.entries(entries).find(([p]) => p.endsWith(suffix));
      const text = (suffix: string) => new TextDecoder().decode(find(suffix)![1]);
      return { entries, find, text, manifest: JSON.parse(text('bundle-manifest.json')) };
    };

    it('형식 파일만 든 번들에 파생 호기(derivedFrom)의 수집값이 실린다 — 형식 모델은 그대로', async () => {
      await collectOnUnit('opc.tcp://127.0.0.1:14850/UA/Simulator', '가상 PLC (시뮬레이션)');
      const { find, text, manifest } = await unpack('');
      expect(manifest.evidence).toHaveLength(1);
      expect(manifest.evidence[0]).toMatchObject({ model: 'RollFormingMachine', instance: 'RollFormingMachine_1', direct: false, samples: 10 });
      // 시뮬레이션뿐이면 C를 제안한다
      expect(manifest.bundle.evidenceLevel).toBe('C');
      const csv = text('05_샘플데이터/수집값_RollFormingMachine_1.csv');
      expect(csv.split('\r\n').filter(Boolean)).toHaveLength(11); // 머리 + 10건
      expect(csv.indexOf('ALARM')).toBeGreaterThan(0);
      const html = text('06_검증결과/수집기록.html');
      expect(html).toContain('증빙 수준 C');
      expect(html).toContain('RUNNING 90%');
      // 🔴 번들의 형식 모델에는 수집 연결이 없다 — 시연본 표시도 없다
      const machine = manifest.models.find((m: any) => m.assetName === 'RollFormingMachine');
      expect(machine.demo).toBeUndefined();
      expect(find('02_참조모델/01-롤포밍기-공34.aasx')).toBeDefined();
    });

    it('🔴 현장 PLC 주소는 공개 번들에서 가린다 — 자기 PC 주소만 그대로', async () => {
      await collectOnUnit('opc.tcp://192.168.10.25:4840/PLC', 'A사 1라인 PLC');
      const { text, manifest } = await unpack('&evidence=A');
      expect(manifest.bundle.evidenceLevel).toBe('A');
      expect(manifest.evidence[0].interfaces[0].endpoint).toBe('opc.tcp://(비공개):4840/PLC');
      expect(text('06_검증결과/수집기록.html')).not.toContain('192.168.10.25');
      expect(text('README.md')).not.toContain('192.168.10.25');
    });

    it('시뮬레이션이 아니면 수준을 추측하지 않는다 · none이면 비운다', async () => {
      await collectOnUnit('opc.tcp://192.168.10.25:4840/PLC', 'A사 1라인 PLC');
      expect((await unpack('')).manifest.bundle.evidenceLevel).toBeNull();
      expect((await unpack('&evidence=none')).manifest.bundle.evidenceLevel).toBeNull();
      expect((await h.call('GET', `/packages/${processId}/bundle?evidence=Z`)).status).toBe(400);
    });

    it('수집이 없으면 증빙 파일을 만들지 않고 README가 방법을 알려 준다', async () => {
      const { find, text, manifest } = await unpack('');
      expect(manifest.evidence).toEqual([]);
      expect(find('06_검증결과/수집기록.html')).toBeUndefined();
      expect(text('README.md')).toContain('수집 기록이 없습니다');
    });

    it('화면용 분석에도 증빙 요약이 나온다', async () => {
      await collectOnUnit('opc.tcp://127.0.0.1:14850/UA/Simulator', '가상 PLC (시뮬레이션)');
      const res = await h.call('GET', `/packages/${processId}/bundle/linkage`);
      expect(res.body.evidence.suggested).toBe('C');
      expect(res.body.evidence.sources[0]).toMatchObject({ instance: 'RollFormingMachine_1', samples: 10 });
    });
  });

  describe('🔴 왕복 보존 — 번들을 열었다 다시 내보내도 사람이 넣은 것이 남는다', () => {
    const put = (path: string, data: Uint8Array) =>
      h.call('PUT', `/packages/${processId}/bundle/files?path=${encodeURIComponent(path)}`, data);
    const exportZip = async (harnessed = h, id = processId, query = '') =>
      unzipArchive((await harnessed.call('GET', `/packages/${id}/bundle?code=RB01${query}`)).body as Uint8Array);
    const paths = (entries: Record<string, Uint8Array>) => Object.keys(entries).map((p) => p.split('/').slice(1).join('/'));

    it('화면에서 올린 첨부가 번들에 들어가고, 열었다 다시 내보내도 그대로다', async () => {
      expect((await put('01_UseCase문서/RB01_UseCase.docx', new Uint8Array([1, 2, 3]))).status).toBe(204);
      expect((await put('06_검증결과/KOSMO_Validator_결과.html', new Uint8Array([4]))).status).toBe(204);
      const first = await exportZip();
      expect(paths(first)).toEqual(expect.arrayContaining(['01_UseCase문서/RB01_UseCase.docx', '06_검증결과/KOSMO_Validator_결과.html']));
      const manifest = JSON.parse(new TextDecoder().decode(Object.entries(first).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      expect(manifest.attachments.map((a: any) => a.path)).toEqual(['01_UseCase문서/RB01_UseCase.docx', '06_검증결과/KOSMO_Validator_결과.html']);

      // 다른 사람이 받아 새 저장소에서 열고 → 다시 내보낸다
      const fresh = harness();
      await fresh.store.init();
      const opened = (await fresh.call('POST', '/bundles', zipArchive(first))).body;
      expect(opened.attachments).toEqual(['01_UseCase문서/RB01_UseCase.docx', '06_검증결과/KOSMO_Validator_결과.html']);
      const again = await exportZip(fresh, opened.processPackageId);
      const doc = Object.entries(again).find(([p]) => p.endsWith('01_UseCase문서/RB01_UseCase.docx'))![1];
      expect([...doc]).toEqual([1, 2, 3]);
      expect(paths(again)).toContain('06_검증결과/KOSMO_Validator_결과.html');
    });

    it('첨부를 보관해도 공정 파일 해시는 그대로다 — AASX에 섞이지 않는다', async () => {
      const before = JSON.parse(new TextDecoder().decode(Object.entries(await exportZip()).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      await put('03_가이던스/guide.docx', new Uint8Array([7]));
      const after = JSON.parse(new TextDecoder().decode(Object.entries(await exportZip()).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      expect(after.process[0].sha256).toBe(before.process[0].sha256);
    });

    it('도구가 만드는 파일·폴더 밖·경로 탈출은 첨부로 받지 않는다', async () => {
      for (const bad of ['README.md', '02_참조모델/x.aasx', '06_검증결과/사전점검_x.html', '../escape.txt', '01_UseCase문서/../../x', 'misc/x.txt', '']) {
        expect((await put(bad, new Uint8Array([1]))).status).toBe(400);
      }
    });

    it('지우면 다음 번들에서 빠진다', async () => {
      await put('04_데이터연계정의/KPI.xlsx', new Uint8Array([1]));
      expect((await h.call('DELETE', `/packages/${processId}/bundle/files?path=${encodeURIComponent('04_데이터연계정의/KPI.xlsx')}`)).status).toBe(204);
      expect(paths(await exportZip())).not.toContain('04_데이터연계정의/KPI.xlsx');
      expect((await h.call('DELETE', `/packages/${processId}/bundle/files?path=${encodeURIComponent('04_데이터연계정의/KPI.xlsx')}`)).status).toBe(404);
    });

    it('수집 기록도 이어받는다 — 새로 모은 값이 없으면 이전 번들의 증빙이 그대로 실린다', async () => {
      // 수집한 번들을 만든다
      const unit = (await h.call('POST', `/packages/${machineId}/clone`, { assetName: 'RollFormingMachine_1' })).body.packageId;
      await h.call('POST', `/packages/${unit}/aid`, {
        endpoint: 'opc.tcp://127.0.0.1:14850/UA/Simulator',
        title: '가상 PLC (시뮬레이션)',
        tags: [{ name: 'MachineState', href: 'ns=1;s=RollFormingMachine_1.MachineState', type: 'string' }],
      });
      await h.store.appendValues(unit, [
        { packageId: unit, interfaceName: 'I', propertyName: 'MachineState', observedAt: '2026-09-30T03:00:00Z', valueText: 'RUNNING', quality: 'Good' },
      ]);
      const withEvidence = await exportZip();

      // 형식 파일만 있는 곳(호기 없음)에서 연다 → 새 수집 없음 → 이어받는다
      const fresh = harness();
      await fresh.store.init();
      const opened = (await fresh.call('POST', '/bundles', zipArchive(withEvidence))).body;
      const view = (await fresh.call('GET', `/packages/${opened.processPackageId}/bundle/linkage`)).body;
      expect(view.evidence.sources).toEqual([]);
      expect(view.evidence.carried.entries[0].instance).toBe('RollFormingMachine_1');

      const again = await exportZip(fresh, opened.processPackageId);
      const manifest = JSON.parse(new TextDecoder().decode(Object.entries(again).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      expect(manifest.bundle.evidenceLevel).toBe('C');
      expect(manifest.evidence[0]).toMatchObject({ instance: 'RollFormingMachine_1', carried: true });
      expect(paths(again)).toEqual(expect.arrayContaining(['05_샘플데이터/수집값_RollFormingMachine_1.csv', '06_검증결과/수집기록.html']));
    });

    it('증빙 기간 — 최근 N분만 싣는다', async () => {
      const unit = (await h.call('POST', `/packages/${machineId}/clone`, { assetName: 'RollFormingMachine_1' })).body.packageId;
      await h.call('POST', `/packages/${unit}/aid`, {
        endpoint: 'opc.tcp://127.0.0.1:14850/UA/Simulator',
        title: '가상 PLC (시뮬레이션)',
        tags: [{ name: 'MachineState', href: 'ns=1;s=RollFormingMachine_1.MachineState', type: 'string' }],
      });
      const now = Date.now();
      await h.store.appendValues(unit, [
        { packageId: unit, interfaceName: 'I', propertyName: 'MachineState', observedAt: new Date(now - 3 * 3600_000).toISOString(), valueText: 'OLD', quality: 'Good' },
        { packageId: unit, interfaceName: 'I', propertyName: 'MachineState', observedAt: new Date(now - 60_000).toISOString(), valueText: 'RUNNING', quality: 'Good' },
      ]);
      const all = (await h.call('GET', `/packages/${processId}/bundle/linkage`)).body.evidence.sources[0].samples;
      const recent = (await h.call('GET', `/packages/${processId}/bundle/linkage?evidenceMinutes=10`)).body.evidence.sources[0].samples;
      expect([all, recent]).toEqual([2, 1]);
      const manifest = JSON.parse(new TextDecoder().decode(Object.entries(await exportZip(h, processId, '&evidenceMinutes=10')).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      expect(manifest.evidence[0].samples).toBe(1);
      expect((await h.call('GET', `/packages/${processId}/bundle?evidenceMinutes=-5`)).status).toBe(400);
    });

    it('설비 카드에 표준(AASd-120) 건수가 따로 나온다 — KOSMO는 안 보지만 표준 검증기는 오류로 본다', async () => {
      const view = (await h.call('GET', `/packages/${processId}/bundle/linkage`)).body;
      const machine = view.members.find((m: any) => m.name === 'RollFormingMachine');
      expect(typeof machine.lint.aasd120).toBe('number');
    });
  });

  describe('🔴 원본 그대로 — 번들의 참조모델 해시가 운영기관 제출본과 같아야 한다', () => {
    const raw = () => new Uint8Array(readFileSync('tests/fixtures/03-SPR장비-뿌80.aasx'));
    const manifestOf = (entries: Record<string, Uint8Array>) =>
      JSON.parse(new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));

    /** API로 올린 설비(원본 보관)로 공정을 새로 짠다 */
    const setup = async () => {
      const uploaded = await h.call('POST', `/packages?name=${encodeURIComponent('03-SPR장비-뿌80.aasx')}`, raw());
      const id = uploaded.body.packageId;
      const proc = (await h.call('POST', '/packages/new', { assetName: 'SprLine', unit: 'composite' })).body.packageId;
      await h.call('POST', `/packages/${proc}/hierarchy/nodes`, { sourcePackageId: id });
      return { id, proc };
    };

    it('고치지 않았으면 올린 파일 바이트 그대로 들어간다', async () => {
      const { proc } = await setup();
      const entries = unzipArchive((await h.call('GET', `/packages/${proc}/bundle?code=RB01`)).body);
      const model = manifestOf(entries).models[0];
      expect(model.original).toBe(true);
      expect(model.sha256).toBe(sha(raw()));
      expect([...entries[Object.keys(entries).find((p) => p.endsWith(model.file))!]!]).toEqual([...raw()]);
    });

    it('도구에서 고치면 다시 포장하고 그렇다고 밝힌다', async () => {
      const { id, proc } = await setup();
      const sm = (await h.store.listIdentifiables(id, 'Submodel')).items.find((s) => s.idShort === 'TechnicalData')!;
      await h.store.updateIdentifiable(id, 'Submodel', sm.id, { ...sm.content, description: [{ language: 'ko', text: '고침' }] });
      const entries = unzipArchive((await h.call('GET', `/packages/${proc}/bundle?code=RB01`)).body);
      const model = manifestOf(entries).models[0];
      expect(model.original).toBe(false);
      expect(model.sha256).not.toBe(sha(raw()));
      expect(new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith('README.md'))![1])).toContain('다시 포장');
    });

    it('번들을 열었다 다시 내보내도 원본 해시가 이어진다', async () => {
      const { proc } = await setup();
      const first = (await h.call('GET', `/packages/${proc}/bundle?code=RB01`)).body as Uint8Array;
      const fresh = harness();
      await fresh.store.init();
      const opened = (await fresh.call('POST', '/bundles', first)).body;
      const again = unzipArchive((await fresh.call('GET', `/packages/${opened.processPackageId}/bundle?code=RB01`)).body);
      const model = manifestOf(again).models[0];
      expect(model.original).toBe(true);
      expect(model.sha256).toBe(sha(raw()));
    });
  });

  it('설비 파일에서는 번들을 만들지 않는다 — 400', async () => {
    const res = await h.call('GET', `/packages/${machineId}/bundle`);
    expect(res.status).toBe(400);
  });

  it('번들 ZIP — 폴더 골격 · manifest 해시가 실제 파일과 맞는다', async () => {
    const res = await h.call('GET', `/packages/${processId}/bundle?code=RB01&version=1.0.0`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const entries = unzipArchive(res.body as Uint8Array);
    const paths = Object.keys(entries);
    const root = paths[0]!.split('/')[0]!;
    expect(root).toBe('RB01_생산최적화품질관리_v1.0.0');
    for (const folder of ['00_공정구성', '01_UseCase문서', '02_참조모델', '03_가이던스', '04_데이터연계정의', '05_샘플데이터', '06_검증결과']) {
      expect(paths.some((p) => p.startsWith(`${root}/${folder}/`))).toBe(true);
    }
    const manifest = JSON.parse(new TextDecoder().decode(entries[`${root}/bundle-manifest.json`]));
    expect(manifest.bundle.code).toBe('RB01');
    expect(manifest.bundle.evidenceLevel).toBeNull();
    expect(manifest.models).toHaveLength(2);
    expect(manifest.planned.map((p: any) => p.assetName)).toEqual(['FuturePress']);
    for (const entry of [...manifest.process, ...manifest.models]) {
      expect(sha(entries[`${root}/${entry.file}`]!)).toBe(entry.sha256);
    }
    // 🔴 번들의 설비 파일은 원본과 같은 모델이다(복사하면서 바뀌지 않는다)
    const machine = manifest.models.find((m: any) => m.assetName === 'RollFormingMachine');
    const inBundle = readAasx(entries[`${root}/${machine.file}`]!);
    const original = await h.store.exportPackage(machineId);
    expect(inBundle.environment).toEqual(original.environment);
    expect(entries[`${root}/README.md`]).toBeDefined();
    // 엑셀이 한글을 깨뜨리지 않게 BOM(EF BB BF)이 붙어 있어야 한다
    expect([...entries[`${root}/04_데이터연계정의/연계항목_초안.csv`]!.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('같은 내용이면 번들 해시도 같다 — 재현 가능', async () => {
    const a = await h.call('GET', `/packages/${processId}/bundle?code=RB01`);
    const b = await h.call('GET', `/packages/${processId}/bundle?code=RB01`);
    const ma = JSON.parse(new TextDecoder().decode(Object.entries(unzipArchive(a.body)).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
    const mb = JSON.parse(new TextDecoder().decode(Object.entries(unzipArchive(b.body)).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
    expect(ma.models.map((m: any) => m.sha256)).toEqual(mb.models.map((m: any) => m.sha256));
  });

  it('잘못된 코드·버전은 400', async () => {
    expect((await h.call('GET', `/packages/${processId}/bundle?code=X1`)).status).toBe(400);
    expect((await h.call('GET', `/packages/${processId}/bundle?version=v1`)).status).toBe(400);
  });

  it('번들 열기 — 새 저장소에 공정·설비가 한 번에 열리고 해시가 맞는다', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const fresh = harness();
    await fresh.store.init();
    const opened = await fresh.call('POST', '/bundles', zip);
    expect(opened.status).toBe(201);
    expect(opened.body.problems).toEqual([]);
    expect(opened.body.files).toHaveLength(3);
    expect(opened.body.files.every((f: any) => f.hashOk === true)).toBe(true);
    // 열린 공정에서 설비가 이어진다
    const linkage = await fresh.call('GET', `/packages/${opened.body.processPackageId}/bundle/linkage`);
    expect(linkage.body.members.filter((m: any) => m.packageId).length).toBe(2);
  });

  it('이미 같은 파일이 열려 있으면 새로 올리지 않는다', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const before = (await h.store.listPackages({ limit: 100 })).items.length;
    const opened = await h.call('POST', '/bundles', zip);
    expect(opened.body.files.every((f: any) => f.reused)).toBe(true);
    expect((await h.store.listPackages({ limit: 100 })).items.length).toBe(before);
  });

  it('번들을 만든 뒤 파일이 바뀌면 해시 불일치로 알린다', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const entries = unzipArchive(zip);
    const target = Object.keys(entries).find((p) => p.includes('/02_참조모델/'))!;
    // 다른 설비 파일로 바꿔치기
    entries[target] = new Uint8Array(readFileSync('tests/fixtures/11-협동로봇6축.aasx'));
    const fresh = harness();
    await fresh.store.init();
    const opened = await fresh.call('POST', '/bundles', zipArchive(entries));
    expect(opened.status).toBe(201);
    expect(opened.body.problems.some((p: string) => p.includes('해시'))).toBe(true);
  });

  it('manifest가 없는 ZIP은 400', async () => {
    const fresh = harness();
    await fresh.store.init();
    const res = await fresh.call('POST', '/bundles', zipArchive({ 'a.txt': new Uint8Array([1]) }));
    expect(res.status).toBe(400);
  });
});
