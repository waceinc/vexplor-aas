/**
 * 공정 단위 API.
 *
 * 🔴 이 시험의 요점: **설비 파일을 고르기만 하면 매달리는가.**
 * 이름과 Asset 주소를 손으로 옮겨 적게 하면 거기서 오타가 난다 —
 * 그 끈이 공정 파일과 설비 파일을 잇는 유일한 연결이라 틀리면 조용히 끊긴다.
 *
 * 그리고 **설비 파일을 망가뜨리지 않는가.** 공정 기능이 설비 쪽 동작을 바꾸면 안 된다.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

const golden = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')));
const robot = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/11-협동로봇6축.aasx')));

/* eslint-disable @typescript-eslint/no-explicit-any */
function harness() {
  const store = new InMemoryStore();
  const handle = createApi(store);
  const call = async (
    method: string,
    rawPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> => {
    // 실서버(toApiRequest)처럼 질의 인자를 뗀다 — 안 떼면 경로 대조가 어긋나 404가 된다
    const [path, queryText] = rawPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(queryText ?? ''));
    const response = await handle({
      method,
      path,
      query,
      queryAll: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]])),
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body } : {}),
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };
  return { store, call };
}

describe('공정 만들기', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.store.init();
  });

  it('unit=process면 계층이 채워진 채로 태어난다', async () => {
    const created = await h.call('POST', '/packages/new', {
      assetName: 'WeldingProcess',
      unit: 'process',
    });
    expect(created.status).toBe(201);

    const hierarchy = await h.call('GET', `/packages/${created.body.packageId}/hierarchy`);
    expect(hierarchy.status).toBe(200);
    expect(hierarchy.body.entryNode.name).toBe('WeldingProcess');
    expect(hierarchy.body.children).toEqual([]);
  });

  it('태어나자마자 위반 0건이다', async () => {
    const created = await h.call('POST', '/packages/new', {
      assetName: 'WeldingProcess',
      unit: 'process',
    });
    const lint = await h.call('GET', `/packages/${created.body.packageId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('unit을 주지 않으면 종전대로 설비다 — 기존 동작을 바꾸지 않는다', async () => {
    const created = await h.call('POST', '/packages/new', { assetName: 'TestMachine' });
    const hierarchy = await h.call('GET', `/packages/${created.body.packageId}/hierarchy`);
    expect(hierarchy.body.entryNode).toBeNull();
  });
});

describe('설비 매달기', () => {
  let h: ReturnType<typeof harness>;
  let processId: string;
  let machineId: string;
  let robotId: string;

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    machineId = (await h.store.importPackage({ name: '01.aasx', package: golden() })).id;
    robotId = (await h.store.importPackage({ name: '11.aasx', package: robot() })).id;
    const created = await h.call('POST', '/packages/new', {
      assetName: 'WeldingProcess',
      unit: 'process',
    });
    processId = created.body.packageId;
  });

  it('올려 둔 설비를 고르면 이름과 Asset 주소를 그 파일에서 읽는다', async () => {
    const added = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
    });
    expect(added.status).toBe(201);
    expect(added.body.name).toBe('RollFormingMachine');
    expect(added.body.globalAssetId).toBe(
      'https://www.smart-factory.kr/ids/asset/RollFormingMachine/1/0',
    );
  });

  it('두 대를 매달고도 위반이 없다', async () => {
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machineId });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: robotId });

    const hierarchy = await h.call('GET', `/packages/${processId}/hierarchy`);
    expect(hierarchy.body.children.map((c: any) => c.name)).toEqual([
      'RollFormingMachine',
      'CollabRobot6Axis',
    ]);
    const lint = await h.call('GET', `/packages/${processId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('손으로 적어 넣을 수도 있다 — 아직 파일이 없는 설비를 미리 적을 때', async () => {
    const added = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      name: 'FuturePress',
      globalAssetId: 'https://www.smart-factory.kr/ids/asset/FuturePress/1/0',
      bulkCount: 3,
    });
    expect(added.status).toBe(201);
    const hierarchy = await h.call('GET', `/packages/${processId}/hierarchy`);
    expect(hierarchy.body.children[0].bulkCount).toBe(3);
  });

  it('같은 설비를 두 번 매달지 못한다', async () => {
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machineId });
    const again = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
    });
    expect(again.status).toBe(400);
  });

  it('자기 자신을 매달지 못한다', async () => {
    const self = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      sourcePackageId: processId,
    });
    expect(self.status).toBe(400);
  });

  it('뺄 때 관계도 함께 빠진다 — 위반이 남지 않는다', async () => {
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machineId });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: robotId });

    const removed = await h.call('DELETE', `/packages/${processId}/hierarchy/nodes/RollFormingMachine`);
    expect(removed.status).toBe(204);

    const hierarchy = await h.call('GET', `/packages/${processId}/hierarchy`);
    expect(hierarchy.body.children.map((c: any) => c.name)).toEqual(['CollabRobot6Axis']);
    const lint = await h.call('GET', `/packages/${processId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('없는 것을 빼려 하면 404다', async () => {
    const removed = await h.call('DELETE', `/packages/${processId}/hierarchy/nodes/NoSuchThing`);
    expect(removed.status).toBe(404);
  });

  it('설비 파일의 계층도 읽힌다 — 설비도 부품 계층을 갖고 있다', async () => {
    const hierarchy = await h.call('GET', `/packages/${machineId}/hierarchy`);
    expect(hierarchy.body.entryNode.name).toBe('RollFormingMachine');
    expect(hierarchy.body.children.map((c: any) => c.name)).toEqual([
      'Uncoiler',
      'RollStandUnit',
      'CutOffPress',
    ]);
    // BulkCount가 그대로 읽힌다(RollStandUnit 12대)
    expect(hierarchy.body.children[1].bulkCount).toBe(12);
  });
});

/**
 * 이력·되돌리기.
 *
 * 🔴 요점: **실수를 복구할 수 있는가.** 저장소는 처음부터 변경 전 내용을 쌓아 왔는데
 * 꺼내 쓸 길이 없었다 — 실사용 검증(직접 제작)에서 확인된 구멍이다.
 * 되돌리기 자체도 이력에 남아야 한다 — 되돌린 것을 또 되돌릴 수 있어야 안전망이다.
 */
describe('이력과 되돌리기', () => {
  let h: ReturnType<typeof harness>;
  let packageId: string;
  const SM = 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/TechnicalData/2/1';
  const encode = (text: string): string => Buffer.from(text).toString('base64url');

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    packageId = (await h.store.importPackage({ name: 'g.aasx', package: golden() })).id;
  });

  it('고치면 이력이 생기고, 그 판으로 되돌릴 수 있다', async () => {
    const before = await h.store.getIdentifiable(packageId, 'Submodel', SM);
    const beforeCount = (before!.content['submodelElements'] as unknown[]).length;

    // 요소를 전부 비우는 파괴적 편집 (실수 시나리오)
    await h.store.updateIdentifiable(packageId, 'Submodel', SM, {
      ...before!.content,
      submodelElements: [{ idShort: 'Oops', modelType: 'Property', valueType: 'xs:string' }],
    });

    const history = await h.call('GET', `/packages/${packageId}/history/${encode(SM)}`);
    expect(history.status).toBe(200);
    expect(history.body.result).toHaveLength(1);
    // elementCount는 재귀 집계(하위 포함)라 최상위 개수보다 크다 — 있는지만 본다
    expect(history.body.result[0].elementCount).toBeGreaterThan(beforeCount);

    // 되돌린다
    const restored = await h.call(
      'POST',
      `/packages/${packageId}/history/${encode(SM)}/restore`,
      { changedAt: history.body.result[0].changedAt },
    );
    expect(restored.status).toBe(200);
    const after = await h.store.getIdentifiable(packageId, 'Submodel', SM);
    expect((after!.content['submodelElements'] as unknown[]).length).toBe(beforeCount);

    // 🔴 되돌리기 자체도 이력에 남는다 — 되돌린 것을 또 되돌릴 수 있다
    const again = await h.call('GET', `/packages/${packageId}/history/${encode(SM)}`);
    expect(again.body.result).toHaveLength(2);
  });

  it('없는 시각으로 되돌리려 하면 404다', async () => {
    const bad = await h.call(
      'POST',
      `/packages/${packageId}/history/${encode(SM)}/restore`,
      { changedAt: '2000-01-01T00:00:00.000Z' },
    );
    expect(bad.status).toBe(404);
  });
});

/**
 * 회사 단위와 순환 방지.
 * 계층은 재귀다(RAMI 4.0: 기업→공장→스테이션→설비) — 회사는 공정과 같은 구조에
 * 이름표(assetType)만 다르다. 재귀가 되면서 순환(A⊃B⊃A)이 실제로 만들 수 있는
 * 실수가 됐다 — 서버가 막아야 한다.
 */
describe('회사 단위와 순환 방지', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.store.init();
  });

  it('회사를 만들면 계층만 들어가고 위반 0건이다', async () => {
    const created = await h.call('POST', '/packages/new', {
      assetName: 'OurFactory',
      unit: 'company',
    });
    expect(created.status).toBe(201);
    const lint = await h.call('GET', `/packages/${created.body.packageId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('회사 → 공정 → (순환 시도) 회사를 넣으면 400이다', async () => {
    const company = (
      await h.call('POST', '/packages/new', { assetName: 'OurFactory', unit: 'company' })
    ).body.packageId;
    const line = (
      await h.call('POST', '/packages/new', { assetName: 'PressLine', unit: 'process' })
    ).body.packageId;

    // 회사에 공정을 넣는다 — 정상
    const ok = await h.call('POST', `/packages/${company}/hierarchy/nodes`, {
      sourcePackageId: line,
    });
    expect(ok.status).toBe(201);

    // 공정에 회사를 넣으려 하면 — 순환이다
    const cycle = await h.call('POST', `/packages/${line}/hierarchy/nodes`, {
      sourcePackageId: company,
    });
    expect(cycle.status).toBe(400);
    expect(JSON.stringify(cycle.body)).toContain('순환');
  });
});

/**
 * 한 파일 안의 중첩 — 회사>공정>장비.
 *
 * 🔴 요점: 층마다 파일을 만들 필요가 없다. 그룹(CoManagedEntity — 파일 없는 중간 마디)을
 * 만들고 그 밑에 설비를 넣는다. 골든 파일의 부품 중첩과 같은 문법이다.
 */
describe('한 파일 안의 중첩 (그룹)', () => {
  let h: ReturnType<typeof harness>;
  let companyId: string;
  let machineId: string;

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    machineId = (await h.store.importPackage({ name: 'g.aasx', package: golden() })).id;
    companyId = (
      await h.call('POST', '/packages/new', { assetName: 'WaceFactory', unit: 'composite' })
    ).body.packageId;
  });

  it('그룹을 만들고 그 밑에 설비를 넣으면 중첩 트리로 나온다', async () => {
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      name: 'WeldingProcess',
      group: true,
    });
    const added = await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
      bulkCount: 2,
      parentPath: ['WeldingProcess'],
    });
    expect(added.status).toBe(201);

    const view = await h.call('GET', `/packages/${companyId}/hierarchy`);
    expect(view.body.children).toHaveLength(1);
    const process = view.body.children[0];
    expect(process.name).toBe('WeldingProcess');
    expect(process.globalAssetId).toBe(''); // 그룹은 파일이 없다
    expect(process.children[0].name).toBe('RollFormingMachine');
    expect(process.children[0].bulkCount).toBe(2);

    // 규칙도 통과해야 한다 — CoManagedEntity는 globalAssetId가 없어도 된다(AASd-014)
    const lint = await h.call('GET', `/packages/${companyId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('같은 설비를 서로 다른 그룹에는 넣을 수 있다 — 같은 그룹에는 못 넣는다', async () => {
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, { name: 'ProcA', group: true });
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, { name: 'ProcB', group: true });
    const first = await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
      parentPath: ['ProcA'],
    });
    expect(first.status).toBe(201);
    const other = await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
      parentPath: ['ProcB'],
    });
    expect(other.status).toBe(201); // 다른 공정에 같은 모델 — 실제로 있는 일이다
    const dup = await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
      parentPath: ['ProcA'],
    });
    expect(dup.status).toBe(400); // 같은 자리에 두 번은 안 된다
  });

  it('그룹 속 그룹도 되고, 깊은 층에도 globalAssetId 키가 있다', async () => {
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, { name: 'ProcA', group: true });
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      name: 'SubProc',
      group: true,
      parentPath: ['ProcA'],
    });
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
      parentPath: ['ProcA', 'SubProc'],
    });

    const view = await h.call('GET', `/packages/${companyId}/hierarchy`);
    const sub = view.body.children[0].children[0];
    // 🔴 키가 빠지면 화면이 그룹을 설비로 착각한다 — 실측으로 잡힌 버그
    expect(sub.globalAssetId).toBe('');
    expect(sub.children[0].name).toBe('RollFormingMachine');
    expect(typeof sub.children[0].globalAssetId).toBe('string');
    const lint = await h.call('GET', `/packages/${companyId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('중첩된 자식을 경로로 뺄 수 있다 — 관계도 함께 빠진다', async () => {
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, { name: 'ProcA', group: true });
    await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
      parentPath: ['ProcA'],
    });
    const removed = await h.call(
      'DELETE',
      `/packages/${companyId}/hierarchy/nodes/RollFormingMachine?parent=ProcA`,
    );
    expect(removed.status).toBe(204);
    const view = await h.call('GET', `/packages/${companyId}/hierarchy`);
    expect(view.body.children[0].children).toEqual([]);
    const lint = await h.call('GET', `/packages/${companyId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });
});

/**
 * 수집 연결(AID)의 자기모순 회귀 — 도구가 만든 것이 도구 규칙에 걸리면 안 된다.
 * 실측(2026-08-26 전문가 시연): IDTA IRI를 semanticId로 직접 써서 KOSMO-SME-3
 * 13건으로 태어났고, 「고치기」로 이관하면 IDTA 표시가 사라졌다.
 */
describe('AID는 태어나자마자 규칙을 지킨다', () => {
  it('만들면 위반 0건이고 IDTA 원본은 supplemental로 남는다', async () => {
    const h = harness();
    await h.store.init();
    const pid = (await h.store.importPackage({ name: 'g.aasx', package: golden() })).id;

    const made = await h.call('POST', `/packages/${pid}/aid`, {
      endpoint: 'opc.tcp://127.0.0.1:14840/UA/Test',
      tags: [{ name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float' }],
    });
    expect(made.status).toBe(201);

    const lint = await h.call('GET', `/packages/${pid}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);

    const submodels = await h.call('GET', `/packages/${pid}/api/v3.0/submodels`);
    const aid = submodels.body.result.find(
      (sm: { idShort?: string }) => sm.idShort === 'AssetInterfacesDescription',
    )!;
    const iface = aid.submodelElements[0];
    // 자체 IRI가 semanticId, IDTA가 supplemental — kosmo-first 짝(계층과 같은 패턴)
    expect(iface.semanticId.keys[0].value).toContain('smart-factory.kr/ids/cd/');
    expect(iface.supplementalSemanticIds[0].keys[0].value).toContain('admin-shell.io/idta');
  });

  /**
   * 🔴 수집 연결의 **나머지 절반** — 태그가 얹힐 자리까지 세워야 값이 밖으로 나간다.
   * 그리고 그렇게 세운 것도 **태어나자마자 규칙을 지켜야** 한다. 위 시험과 같은 이유다.
   */
  it('자리를 함께 세워도 위반 0건이고, KTL 계층을 지킨다', async () => {
    const h = harness();
    await h.store.init();
    const pid = (await h.store.importPackage({ name: 'g.aasx', package: golden() })).id;

    const made = await h.call('POST', `/packages/${pid}/aid`, {
      endpoint: 'opc.tcp://127.0.0.1:14840/UA/Test',
      tags: [
        { name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float', unit: 'rpm' },
        // 🔴 **단위 없는 실수 태그.** 화면에서 단위 칸을 없앴으므로 실제로는 이쪽이 보통이다 —
        //    이걸 시험에 안 넣었다가 AASc-3a-009 위반 3건을 만들어 놓고 몰랐다(실측)
        { name: 'MotorTemperature', href: 'ns=1;s=Machine.Temp', type: 'float' },
        // 골든 파일에 이미 있는 이름 — 건드리면 안 된다
        { name: 'CurrentLineSpeed', href: 'ns=1;s=Machine.Line', type: 'float' },
      ],
      createMissing: { group: 'ProcessMonitoring', subgroup: 'CollectedValues' },
    });
    expect(made.status).toBe(201);
    expect(made.body.elementsAdded).toEqual(['MotorSpeed', 'MotorTemperature']);
    // 자리를 세웠으니 이름이 어긋나지 않는다 = 값이 표준 API로 나간다
    expect(made.body.nameMisses).toEqual([]);

    // 도구가 만든 것이 도구 규칙에 걸리면 안 된다
    const lint = await h.call('GET', `/packages/${pid}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);

    const submodels = await h.call('GET', `/packages/${pid}/api/v3.0/submodels`);
    const od = submodels.body.result.find(
      (sm: { idShort?: string }) => sm.idShort === 'OperationalData',
    )!;

    // KTL 계층: OperationalData > 대분류 > 소분류 > Property (docs/rules/01 §2-2)
    const group = od.submodelElements.find(
      (n: { idShort?: string }) => n.idShort === 'ProcessMonitoring',
    )!;
    const sub = group.value.find((n: { idShort?: string }) => n.idShort === 'CollectedValues')!;
    const prop = sub.value.find((n: { idShort?: string }) => n.idShort === 'MotorSpeed')!;
    expect(prop.modelType).toBe('Property');
    expect(prop.valueType).toBe('xs:double');
    // 🔴 키 타입이 틀리면 basyx가 서브모델을 통째로 드롭한다 — 골든 파일과 같은 형태여야 한다
    expect(prop.semanticId.type).toBe('ModelReference');
    expect(prop.semanticId.keys[0].type).toBe('ConceptDescription');
    // 🔴 예시 데이터가 들어간다. KOSMO-SME-4가 빈 값을 위반으로 보기 때문이다 —
    //    Template의 예시 칸이지 측정값이 아니고, 수집이 붙으면 live/OPC UA에서 덮인다
    expect(prop.value).toBe('0.0');

    // 🔴 이미 있던 것은 그대로다. 골든 파일의 CurrentLineSpeed는 제자리에 값까지 남아 있다
    const forming = group.value.find(
      (n: { idShort?: string }) => n.idShort === 'FormingParameter',
    )!;
    const kept = forming.value.find(
      (n: { idShort?: string }) => n.idShort === 'CurrentLineSpeed',
    )!;
    expect(kept.value).toBe('18.5');
  });
});
