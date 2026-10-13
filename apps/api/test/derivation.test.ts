/**
 * 형식 → 호기 반영 API — 호기별로 나누기로 만든 파일이 형식 파일의 변경을 받아 온다(routes/derivation.ts).
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore, type AasStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listAttachments } from '../src/routes/bundle-files.js';
import { DERIVATION_PART } from '../src/routes/derivation.js';

type Json = Record<string, unknown>;
interface Change {
  key: string;
  path: string;
  kind: string;
  action: string;
  reason?: string;
}
interface Plan {
  linked: boolean;
  sourceName?: string;
  sourceMissing?: boolean;
  changes: Change[];
  counts?: { apply: number; skip: number };
}

const fixtureBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));

function harness(store: AasStore = new InMemoryStore()) {
  const handle = createApi(store);
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const response = await handle({
      method,
      path,
      query: {},
      queryAll: {},
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body } : {}),
    } as ApiRequest);
    return { status: response.status, body: response.body };
  };
  return { store, call };
}

/** 서브모델의 요소 하나를 고친다 — store 를 바로 쓴다(사람이 편집한 것과 같은 길: updateIdentifiable) */
async function setValue(store: AasStore, packageId: string, submodelIdShort: string, idShort: string, value: string): Promise<void> {
  const environment = await store.getEnvironment(packageId);
  const submodel = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === submodelIdShort)!;
  const element = (submodel['submodelElements'] as Json[]).find((e) => e['idShort'] === idShort)!;
  element['value'] = value;
  await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), submodel);
}

async function valueOf(store: AasStore, packageId: string, submodelIdShort: string, idShort: string): Promise<unknown> {
  const environment = await store.getEnvironment(packageId);
  const submodel = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === submodelIdShort)!;
  return (submodel['submodelElements'] as Json[]).find((e) => e['idShort'] === idShort)!['value'];
}

async function setup() {
  const h = harness();
  const type = await h.store.importPackage({ name: '롤포밍기.aasx', package: readAasx(fixtureBytes) });
  const made = await h.call('POST', `/packages/${type.id}/clone`, { assetName: 'RollFormingMachine_1' });
  expect(made.status).toBe(201);
  const instanceId = String((made.body as Json)['packageId']);
  return { ...h, typeId: type.id, instanceId };
}

describe('형식 → 호기 반영 API', () => {
  it('호기별로 나누면 형식과 연결되고, 바로 뒤에는 반영할 것이 없다 — 리비전은 1 그대로', async () => {
    const { call, store, instanceId } = await setup();
    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(plan.linked).toBe(true);
    expect(plan.sourceName).toBe('롤포밍기.aasx');
    expect(plan.counts?.apply).toBe(0);
    expect((await store.getPackage(instanceId))!.revision).toBe(1);
  });

  it('형식을 고치면 반영 대상, 현장에서 고친 값은 건너뜀 — 반영하면 형식 값만 내려오고 현장 값은 그대로', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await setValue(store, instanceId, 'DigitalNameplate', 'SerialNumber', 'SN-0001'); // 현장 수정
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027'); // 형식 수정
    await setValue(store, typeId, 'DigitalNameplate', 'SerialNumber', 'SN-TYPE'); // 형식도 고침 — 현장 값이 이긴다

    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    const byPath = new Map(plan.changes.map((c) => [c.path, c]));
    expect(byPath.get('YearOfConstruction')).toMatchObject({ kind: 'changed', action: 'apply' });
    expect(byPath.get('SerialNumber')).toMatchObject({ kind: 'changed', action: 'skip', reason: 'edited-here' });

    const applied = await call('POST', `/packages/${instanceId}/derivation/apply`, {});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ applied: 1, submodels: 1, skipped: 1 });
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction')).toBe('2027');
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'SerialNumber')).toBe('SN-0001');

    // 반영한 뒤에는 다시 안 보인다
    const after = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(after.counts?.apply).toBe(0);
  });

  it('고른 줄만 반영한다 — 고르지 않은 줄은 다음에도 남는다', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027');
    await setValue(store, typeId, 'DigitalNameplate', 'ManufacturerProductType', 'RF-NEXT');
    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    const year = plan.changes.find((c) => c.path === 'YearOfConstruction')!;
    await call('POST', `/packages/${instanceId}/derivation/apply`, { keys: [year.key] });
    const left = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(left.changes.filter((c) => c.action === 'apply').map((c) => c.path)).toEqual(['ManufacturerProductType']);
  });

  it('반영은 되돌릴 수 있다 — 「↶ 되돌리기」 목록에 「형식 변경 반영」으로 남는다', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027');
    const before = await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction');
    await call('POST', `/packages/${instanceId}/derivation/apply`, {});
    const status = (await call('GET', `/packages/${instanceId}/undo`)).body as { undo: string[] };
    expect(status.undo[0]).toBe('형식 변경 반영');
    await call('POST', `/packages/${instanceId}/undo`);
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction')).toBe(before);
    // 형식 사본(기준값)도 함께 돌아가야 같은 변경이 다시 「반영」으로 보인다 — 값만 돌리면 「이 호기에서 고친 값」으로 잘못 보였다
    const again = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(again.changes.map((c) => [c.path, c.action])).toEqual([['YearOfConstruction', 'apply']]);
    // 다시 하기는 값과 기준을 함께 앞으로
    await call('POST', `/packages/${instanceId}/redo`);
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction')).toBe('2027');
    expect(((await call('GET', `/packages/${instanceId}/derivation`)).body as Plan).counts?.apply).toBe(0);
  });

  it('다른 편집을 되돌려도 형식 연결은 그대로다 — 곁 파일은 반영을 되돌릴 때만 움직인다', async () => {
    const { call, store, typeId } = await setup();
    const older = await store.importPackage({ name: '옛호기.aasx', package: readAasx(fixtureBytes) });
    const environment = await store.getEnvironment(older.id);
    const nameplate = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === 'DigitalNameplate')!;
    const patched = await call('PATCH', `/packages/${older.id}/api/v3.0/submodels/${Buffer.from(String(nameplate['id'])).toString('base64url')}/submodel-elements/SerialNumber/$value`, 'SN-9');
    expect(patched.status).toBe(204);
    await call('PUT', `/packages/${older.id}/derivation`, { sourcePackageId: typeId });
    await call('POST', `/packages/${older.id}/undo`);
    expect(await valueOf(store, older.id, 'DigitalNameplate', 'SerialNumber')).not.toBe('SN-9');
    expect(((await call('GET', `/packages/${older.id}/derivation`)).body as Plan).linked).toBe(true);
  });

  it('형식 사본은 AASX 로 나가지 않고, 번들 첨부 목록에도 섞이지 않는다', async () => {
    const { store, instanceId } = await setup();
    expect((await store.packageFiles(instanceId)).some((f) => f.part === DERIVATION_PART)).toBe(true);
    const exported = await store.exportPackage(instanceId);
    const parts = [...exported.extraParts.keys(), ...exported.supplementaryFiles.map((f) => f.part)];
    expect(parts.some((part) => part.includes('.derivation'))).toBe(false);
    expect(await listAttachments(store, instanceId)).toEqual([]);
  });

  it('올린 원본(/.original/)도 번들 첨부 목록에 섞이지 않는다', async () => {
    const { call, store } = harness();
    const uploaded = await call('POST', '/packages', undefined);
    expect(uploaded.status).toBeGreaterThanOrEqual(400); // 몸이 없는 업로드는 거절 — 아래는 store 로 직접
    const record = await store.importPackage({
      name: 'a.aasx',
      package: readAasx(fixtureBytes),
      keep: [{ part: '/.original/source.aasx', role: 'bundle', contentType: 'application/octet-stream', data: fixtureBytes }],
    });
    expect(await listAttachments(store, record.id)).toEqual([]);
  });

  it('이 기능 전에 만든 호기도 연결할 수 있다 — 기준은 연결한 때의 형식. 끊으면 연결 없음', async () => {
    const { call, store, typeId } = await setup();
    const older = await store.importPackage({ name: '옛호기.aasx', package: readAasx(fixtureBytes) });
    expect(((await call('GET', `/packages/${older.id}/derivation`)).body as Plan).linked).toBe(false);
    expect((await call('PUT', `/packages/${older.id}/derivation`, { sourcePackageId: older.id })).status).toBe(400);
    expect((await call('PUT', `/packages/${older.id}/derivation`, { sourcePackageId: typeId })).status).toBe(200);
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027');
    const plan = (await call('GET', `/packages/${older.id}/derivation`)).body as Plan;
    expect(plan.changes.map((c) => [c.path, c.action])).toEqual([['YearOfConstruction', 'apply']]);
    expect((await call('DELETE', `/packages/${older.id}/derivation`)).status).toBe(204);
    expect(((await call('GET', `/packages/${older.id}/derivation`)).body as Plan).linked).toBe(false);
  });

  it('형식 파일이 지워지면 그 사실을 말하고, 반영은 거절한다', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await store.deletePackage(typeId);
    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(plan).toMatchObject({ linked: true, sourceMissing: true, changes: [] });
    expect((await call('POST', `/packages/${instanceId}/derivation/apply`, {})).status).toBe(409);
  });
});
