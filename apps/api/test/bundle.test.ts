/**
 * Reference bundle — export one process file as a submission package and open it again.
 *
 * Important: the point of this test: **does the hash tell us whether the model in the bundle has the same content as the model currently open?**
 * It is the only safeguard against the "model changed but the bundle still holds the old revision" incident.
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
  /** For calling while logged in — used by tests that check the audit record (who exported it) */
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

describe('reference bundle', () => {
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

  it('Important: records who exported it — a submission package must name the person to ask', async () => {
    await h.loginAs('품질팀 홍길동');
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const entries = unzipArchive(zip);
    const text = (suffix: string) =>
      new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith(suffix))![1]);
    expect(JSON.parse(text('bundle-manifest.json')).bundle.createdBy).toBe('품질팀 홍길동');
    expect(text('README.md')).toContain('내보낸 사람: 품질팀 홍길동');
  });

  it('a server without login leaves it empty — it does not pretend to know what it does not know', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const entries = unzipArchive(zip);
    const text = (suffix: string) =>
      new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith(suffix))![1]);
    expect(JSON.parse(text('bundle-manifest.json')).bundle.createdBy).toBeNull();
    expect(text('README.md')).not.toContain('내보낸 사람');
  });

  it('linkage analysis — gives equipment readiness and common items', async () => {
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
    // The bundle only holds together if the two pieces of equipment share an operational data item
    expect(res.body.linkage.items.some((i: any) => i.coverage === 2)).toBe(true);
  });

  it('Important: equipment with a collection connection (AID) is flagged as a demo copy — so it is not mixed with the submission copy', async () => {
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

  describe('runtime evidence — collection records in place of a live demo', () => {
    /** Clone a unit from the type (roll forming machine), then accumulate a collection connection and values on that unit */
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

    it('a bundle holding only the type file carries the collected values of derived units (derivedFrom) — the type model stays as is', async () => {
      await collectOnUnit('opc.tcp://127.0.0.1:14850/UA/Simulator', '가상 PLC (시뮬레이션)');
      const { find, text, manifest } = await unpack('');
      expect(manifest.evidence).toHaveLength(1);
      expect(manifest.evidence[0]).toMatchObject({ model: 'RollFormingMachine', instance: 'RollFormingMachine_1', direct: false, samples: 10 });
      // Simulation only means it proposes C
      expect(manifest.bundle.evidenceLevel).toBe('C');
      const csv = text('05_샘플데이터/수집값_RollFormingMachine_1.csv');
      expect(csv.split('\r\n').filter(Boolean)).toHaveLength(11); // header + 10 rows
      expect(csv.indexOf('ALARM')).toBeGreaterThan(0);
      const html = text('06_검증결과/수집기록.html');
      expect(html).toContain('증빙 수준 C');
      expect(html).toContain('RUNNING 90%');
      // Important: the type model in the bundle has no collection connection — and no demo-copy flag either
      const machine = manifest.models.find((m: any) => m.assetName === 'RollFormingMachine');
      expect(machine.demo).toBeUndefined();
      expect(find('02_참조모델/01-롤포밍기-공34.aasx')).toBeDefined();
    });

    it('Important: field PLC addresses are masked in a public bundle — only the local PC address stays as is', async () => {
      await collectOnUnit('opc.tcp://192.168.10.25:4840/PLC', 'A사 1라인 PLC');
      const { text, manifest } = await unpack('&evidence=A');
      expect(manifest.bundle.evidenceLevel).toBe('A');
      expect(manifest.evidence[0].interfaces[0].endpoint).toBe('opc.tcp://(비공개):4840/PLC');
      expect(text('06_검증결과/수집기록.html')).not.toContain('192.168.10.25');
      expect(text('README.md')).not.toContain('192.168.10.25');
    });

    it('does not guess the level unless it is a simulation · leaves it empty when none', async () => {
      await collectOnUnit('opc.tcp://192.168.10.25:4840/PLC', 'A사 1라인 PLC');
      expect((await unpack('')).manifest.bundle.evidenceLevel).toBeNull();
      expect((await unpack('&evidence=none')).manifest.bundle.evidenceLevel).toBeNull();
      expect((await h.call('GET', `/packages/${processId}/bundle?evidence=Z`)).status).toBe(400);
    });

    it('with no collection, does not create an evidence file and the README explains how', async () => {
      const { find, text, manifest } = await unpack('');
      expect(manifest.evidence).toEqual([]);
      expect(find('06_검증결과/수집기록.html')).toBeUndefined();
      expect(text('README.md')).toContain('수집 기록이 없습니다');
    });

    it('the on-screen analysis also shows an evidence summary', async () => {
      await collectOnUnit('opc.tcp://127.0.0.1:14850/UA/Simulator', '가상 PLC (시뮬레이션)');
      const res = await h.call('GET', `/packages/${processId}/bundle/linkage`);
      expect(res.body.evidence.suggested).toBe('C');
      expect(res.body.evidence.sources[0]).toMatchObject({ instance: 'RollFormingMachine_1', samples: 10 });
    });
  });

  describe('Important: round-trip preservation — what people added survives opening a bundle and exporting it again', () => {
    const put = (path: string, data: Uint8Array) =>
      h.call('PUT', `/packages/${processId}/bundle/files?path=${encodeURIComponent(path)}`, data);
    const exportZip = async (harnessed = h, id = processId, query = '') =>
      unzipArchive((await harnessed.call('GET', `/packages/${id}/bundle?code=RB01${query}`)).body as Uint8Array);
    const paths = (entries: Record<string, Uint8Array>) => Object.keys(entries).map((p) => p.split('/').slice(1).join('/'));

    it('an attachment uploaded from the UI goes into the bundle and stays as is after opening and re-exporting', async () => {
      expect((await put('01_UseCase문서/RB01_UseCase.docx', new Uint8Array([1, 2, 3]))).status).toBe(204);
      expect((await put('06_검증결과/KOSMO_Validator_결과.html', new Uint8Array([4]))).status).toBe(204);
      const first = await exportZip();
      expect(paths(first)).toEqual(expect.arrayContaining(['01_UseCase문서/RB01_UseCase.docx', '06_검증결과/KOSMO_Validator_결과.html']));
      const manifest = JSON.parse(new TextDecoder().decode(Object.entries(first).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      expect(manifest.attachments.map((a: any) => a.path)).toEqual(['01_UseCase문서/RB01_UseCase.docx', '06_검증결과/KOSMO_Validator_결과.html']);

      // Someone else receives it, opens it in a new store → exports it again
      const fresh = harness();
      await fresh.store.init();
      const opened = (await fresh.call('POST', '/bundles', zipArchive(first))).body;
      expect(opened.attachments).toEqual(['01_UseCase문서/RB01_UseCase.docx', '06_검증결과/KOSMO_Validator_결과.html']);
      const again = await exportZip(fresh, opened.processPackageId);
      const doc = Object.entries(again).find(([p]) => p.endsWith('01_UseCase문서/RB01_UseCase.docx'))![1];
      expect([...doc]).toEqual([1, 2, 3]);
      expect(paths(again)).toContain('06_검증결과/KOSMO_Validator_결과.html');
    });

    it('storing attachments does not change the process file hash — they are not mixed into the AASX', async () => {
      const before = JSON.parse(new TextDecoder().decode(Object.entries(await exportZip()).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      await put('03_가이던스/guide.docx', new Uint8Array([7]));
      const after = JSON.parse(new TextDecoder().decode(Object.entries(await exportZip()).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
      expect(after.process[0].sha256).toBe(before.process[0].sha256);
    });

    it('does not accept tool-generated files, files outside the folder, or path traversal as attachments', async () => {
      for (const bad of ['README.md', '02_참조모델/x.aasx', '06_검증결과/사전점검_x.html', '../escape.txt', '01_UseCase문서/../../x', 'misc/x.txt', '']) {
        expect((await put(bad, new Uint8Array([1]))).status).toBe(400);
      }
    });

    it('once deleted, it is left out of the next bundle', async () => {
      await put('04_데이터연계정의/KPI.xlsx', new Uint8Array([1]));
      expect((await h.call('DELETE', `/packages/${processId}/bundle/files?path=${encodeURIComponent('04_데이터연계정의/KPI.xlsx')}`)).status).toBe(204);
      expect(paths(await exportZip())).not.toContain('04_데이터연계정의/KPI.xlsx');
      expect((await h.call('DELETE', `/packages/${processId}/bundle/files?path=${encodeURIComponent('04_데이터연계정의/KPI.xlsx')}`)).status).toBe(404);
    });

    it('collection records carry over too — with no newly collected values, the previous bundle evidence is carried as is', async () => {
      // Build a bundle with collected data
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

      // Open it where there is only the type file (no units) → no new collection → carries over
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

    it('evidence window — carries only the last N minutes', async () => {
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

    it('the equipment card shows the standard (AASd-120) count separately — KOSMO ignores it but standard validators treat it as an error', async () => {
      const view = (await h.call('GET', `/packages/${processId}/bundle/linkage`)).body;
      const machine = view.members.find((m: any) => m.name === 'RollFormingMachine');
      expect(typeof machine.lint.aasd120).toBe('number');
    });
  });

  describe('Important: original as is — the reference model hash in the bundle must match the copy submitted to the operating agency', () => {
    const raw = () => new Uint8Array(readFileSync('tests/fixtures/03-SPR장비-뿌80.aasx'));
    const manifestOf = (entries: Record<string, Uint8Array>) =>
      JSON.parse(new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));

    /** Build a new process from equipment uploaded via the API (original retained) */
    const setup = async () => {
      const uploaded = await h.call('POST', `/packages?name=${encodeURIComponent('03-SPR장비-뿌80.aasx')}`, raw());
      const id = uploaded.body.packageId;
      const proc = (await h.call('POST', '/packages/new', { assetName: 'SprLine', unit: 'composite' })).body.packageId;
      await h.call('POST', `/packages/${proc}/hierarchy/nodes`, { sourcePackageId: id });
      return { id, proc };
    };

    it('if unmodified, the uploaded file bytes go in as is', async () => {
      const { proc } = await setup();
      const entries = unzipArchive((await h.call('GET', `/packages/${proc}/bundle?code=RB01`)).body);
      const model = manifestOf(entries).models[0];
      expect(model.original).toBe(true);
      expect(model.sha256).toBe(sha(raw()));
      expect([...entries[Object.keys(entries).find((p) => p.endsWith(model.file))!]!]).toEqual([...raw()]);
    });

    it('if modified in the tool, it is repackaged and says so', async () => {
      const { id, proc } = await setup();
      const sm = (await h.store.listIdentifiables(id, 'Submodel')).items.find((s) => s.idShort === 'TechnicalData')!;
      await h.store.updateIdentifiable(id, 'Submodel', sm.id, { ...sm.content, description: [{ language: 'ko', text: '고침' }] });
      const entries = unzipArchive((await h.call('GET', `/packages/${proc}/bundle?code=RB01`)).body);
      const model = manifestOf(entries).models[0];
      expect(model.original).toBe(false);
      expect(model.sha256).not.toBe(sha(raw()));
      expect(new TextDecoder().decode(Object.entries(entries).find(([p]) => p.endsWith('README.md'))![1])).toContain('다시 포장');
    });

    it('the original hash carries through opening and re-exporting a bundle', async () => {
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

  it('does not build a bundle from an equipment file — 400', async () => {
    const res = await h.call('GET', `/packages/${machineId}/bundle`);
    expect(res.status).toBe(400);
  });

  it('bundle ZIP — folder skeleton · manifest hashes match the actual files', async () => {
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
    // Important: the equipment file in the bundle is the same model as the original (copying does not change it)
    const machine = manifest.models.find((m: any) => m.assetName === 'RollFormingMachine');
    const inBundle = readAasx(entries[`${root}/${machine.file}`]!);
    const original = await h.store.exportPackage(machineId);
    expect(inBundle.environment).toEqual(original.environment);
    expect(entries[`${root}/README.md`]).toBeDefined();
    // A BOM (EF BB BF) must be present so Excel does not garble Korean text
    expect([...entries[`${root}/04_데이터연계정의/연계항목_초안.csv`]!.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('same content gives the same bundle hash — reproducible', async () => {
    const a = await h.call('GET', `/packages/${processId}/bundle?code=RB01`);
    const b = await h.call('GET', `/packages/${processId}/bundle?code=RB01`);
    const ma = JSON.parse(new TextDecoder().decode(Object.entries(unzipArchive(a.body)).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
    const mb = JSON.parse(new TextDecoder().decode(Object.entries(unzipArchive(b.body)).find(([p]) => p.endsWith('bundle-manifest.json'))![1]));
    expect(ma.models.map((m: any) => m.sha256)).toEqual(mb.models.map((m: any) => m.sha256));
  });

  it('invalid code or version is 400', async () => {
    expect((await h.call('GET', `/packages/${processId}/bundle?code=X1`)).status).toBe(400);
    expect((await h.call('GET', `/packages/${processId}/bundle?version=v1`)).status).toBe(400);
  });

  it('opening a bundle — process and equipment open at once in a new store and the hashes match', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const fresh = harness();
    await fresh.store.init();
    const opened = await fresh.call('POST', '/bundles', zip);
    expect(opened.status).toBe(201);
    expect(opened.body.problems).toEqual([]);
    expect(opened.body.files).toHaveLength(3);
    expect(opened.body.files.every((f: any) => f.hashOk === true)).toBe(true);
    // The equipment is linked from the opened process
    const linkage = await fresh.call('GET', `/packages/${opened.body.processPackageId}/bundle/linkage`);
    expect(linkage.body.members.filter((m: any) => m.packageId).length).toBe(2);
  });

  it('does not upload again if the same file is already open', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const before = (await h.store.listPackages({ limit: 100 })).items.length;
    const opened = await h.call('POST', '/bundles', zip);
    expect(opened.body.files.every((f: any) => f.reused)).toBe(true);
    expect((await h.store.listPackages({ limit: 100 })).items.length).toBe(before);
  });

  it('reports a hash mismatch if a file changes after the bundle was built', async () => {
    const zip = (await h.call('GET', `/packages/${processId}/bundle?code=RB01`)).body as Uint8Array;
    const entries = unzipArchive(zip);
    const target = Object.keys(entries).find((p) => p.includes('/02_참조모델/'))!;
    // Swap in a different equipment file
    entries[target] = new Uint8Array(readFileSync('tests/fixtures/11-협동로봇6축.aasx'));
    const fresh = harness();
    await fresh.store.init();
    const opened = await fresh.call('POST', '/bundles', zipArchive(entries));
    expect(opened.status).toBe(201);
    expect(opened.body.problems.some((p: string) => p.includes('해시'))).toBe(true);
  });

  it('a ZIP without a manifest is 400', async () => {
    const fresh = harness();
    await fresh.store.init();
    const res = await fresh.call('POST', '/bundles', zipArchive({ 'a.txt': new Uint8Array([1]) }));
    expect(res.status).toBe(400);
  });
});
