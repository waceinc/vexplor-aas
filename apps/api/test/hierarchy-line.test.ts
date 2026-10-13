/**
 * 라인 층 — 회사 → 라인 → 공정 → 설비(→ 설비 파일 안 부품) 5단계를 한 파일에 담는다.
 * 라인은 semanticId(자체 IRI …/cd/Line/1/0 + IDTA Node supplemental)로 남고, 용어(CD)를 함께 넣는다.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

interface TreeNode {
  name: string;
  globalAssetId: string;
  line: boolean;
  children: TreeNode[];
}
interface Lint {
  countBySeverity: { error?: number; warning?: number };
  findings: { ruleId: string }[];
}

const golden = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')));

function harness() {
  const store = new InMemoryStore();
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

describe('라인 층', () => {
  let h: ReturnType<typeof harness>;
  let machineId: string;
  const company = async (name: string): Promise<string> =>
    String(((await h.call('POST', '/packages/new', { assetName: name, unit: 'composite' })).body as { packageId: string }).packageId);
  const node = (id: string, body: Record<string, unknown>) => h.call('POST', `/packages/${id}/hierarchy/nodes`, body);
  const lineConcepts = async (id: string): Promise<number> =>
    (await h.store.listIdentifiables(id, 'ConceptDescription')).items.filter((item) => String(item.content['id']).endsWith('/cd/Line/1/0')).length;

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    machineId = (await h.store.importPackage({ name: 'g.aasx', package: golden() })).id;
  });

  it('회사 → 라인 → 공정 → 설비가 한 트리로 나오고, 위반·경고가 라인 없는 구성과 같다', async () => {
    const withLine = await company('WaceFactory');
    expect((await node(withLine, { name: 'BodyLine', group: true, line: true })).status).toBe(201);
    await node(withLine, { name: 'WeldingProcess', group: true, parentPath: ['BodyLine'] });
    await node(withLine, { sourcePackageId: machineId, parentPath: ['BodyLine', 'WeldingProcess'] });

    const view = (await h.call('GET', `/packages/${withLine}/hierarchy`)).body as { children: TreeNode[] };
    const line = view.children[0]!;
    expect(line).toMatchObject({ name: 'BodyLine', globalAssetId: '', line: true });
    expect(line.children[0]).toMatchObject({ name: 'WeldingProcess', line: false });
    expect(line.children[0]!.children[0]!.name).toBe('RollFormingMachine');

    // 같은 구성을 라인 없이(공정이 맨 위) — 라인이 지적을 하나도 더하지 않아야 한다
    const plain = await company('PlainFactory');
    await node(plain, { name: 'WeldingProcess', group: true });
    await node(plain, { sourcePackageId: machineId, parentPath: ['WeldingProcess'] });
    const lintOf = async (id: string): Promise<Lint> => (await h.call('GET', `/packages/${id}/lint`)).body as Lint;
    const [a, b] = [await lintOf(withLine), await lintOf(plain)];
    expect(a.countBySeverity.error ?? 0).toBe(0);
    expect(a.findings.map((f) => f.ruleId).sort()).toEqual(b.findings.map((f) => f.ruleId).sort());
  });

  it('라인 용어(CD)는 처음 라인을 만들 때 한 번만 들어간다 — 라인이 없는 파일에는 없다', async () => {
    const id = await company('WaceFactory');
    expect(await lineConcepts(id)).toBe(0);
    await node(id, { name: 'LineA', group: true, line: true });
    await node(id, { name: 'LineB', group: true, line: true });
    expect(await lineConcepts(id)).toBe(1);
  });

  it('라인은 맨 위에만 — 공정이나 라인 밑에 라인을 넣으면 거절한다', async () => {
    const id = await company('WaceFactory');
    await node(id, { name: 'LineA', group: true, line: true });
    await node(id, { name: 'ProcA', group: true });
    expect((await node(id, { name: 'LineB', group: true, line: true, parentPath: ['LineA'] })).status).toBe(400);
    expect((await node(id, { name: 'LineC', group: true, line: true, parentPath: ['ProcA'] })).status).toBe(400);
  });

  it('라인 만들기를 되돌리면 라인과 용어가 함께 빠진다', async () => {
    const id = await company('WaceFactory');
    await node(id, { name: 'LineA', group: true, line: true });
    await h.call('POST', `/packages/${id}/undo`);
    expect(((await h.call('GET', `/packages/${id}/hierarchy`)).body as { children: TreeNode[] }).children).toEqual([]);
    expect(await lineConcepts(id)).toBe(0);
  });
});
