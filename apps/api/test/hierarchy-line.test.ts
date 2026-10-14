/**
 * Line level — the 5 levels company -> line -> process -> equipment (-> parts inside the equipment file) go in one file.
 * A line is kept as a semanticId (own IRI …/cd/Line/1/0 + IDTA Node supplemental), and the concept description (CD) is added with it.
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

describe('line level', () => {
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

  it('company -> line -> process -> equipment comes out as one tree, with the same violations/warnings as the line-less setup', async () => {
    const withLine = await company('WaceFactory');
    expect((await node(withLine, { name: 'BodyLine', group: true, line: true })).status).toBe(201);
    await node(withLine, { name: 'WeldingProcess', group: true, parentPath: ['BodyLine'] });
    await node(withLine, { sourcePackageId: machineId, parentPath: ['BodyLine', 'WeldingProcess'] });

    const view = (await h.call('GET', `/packages/${withLine}/hierarchy`)).body as { children: TreeNode[] };
    const line = view.children[0]!;
    expect(line).toMatchObject({ name: 'BodyLine', globalAssetId: '', line: true });
    expect(line.children[0]).toMatchObject({ name: 'WeldingProcess', line: false });
    expect(line.children[0]!.children[0]!.name).toBe('RollFormingMachine');

    // The same setup without a line (process at the top) — the line must not add a single finding
    const plain = await company('PlainFactory');
    await node(plain, { name: 'WeldingProcess', group: true });
    await node(plain, { sourcePackageId: machineId, parentPath: ['WeldingProcess'] });
    const lintOf = async (id: string): Promise<Lint> => (await h.call('GET', `/packages/${id}/lint`)).body as Lint;
    const [a, b] = [await lintOf(withLine), await lintOf(plain)];
    expect(a.countBySeverity.error ?? 0).toBe(0);
    expect(a.findings.map((f) => f.ruleId).sort()).toEqual(b.findings.map((f) => f.ruleId).sort());
  });

  it('the line concept description (CD) is added only once, when the first line is created — files without lines have none', async () => {
    const id = await company('WaceFactory');
    expect(await lineConcepts(id)).toBe(0);
    await node(id, { name: 'LineA', group: true, line: true });
    await node(id, { name: 'LineB', group: true, line: true });
    expect(await lineConcepts(id)).toBe(1);
  });

  it('lines only at the top — putting a line under a process or another line is rejected', async () => {
    const id = await company('WaceFactory');
    await node(id, { name: 'LineA', group: true, line: true });
    await node(id, { name: 'ProcA', group: true });
    expect((await node(id, { name: 'LineB', group: true, line: true, parentPath: ['LineA'] })).status).toBe(400);
    expect((await node(id, { name: 'LineC', group: true, line: true, parentPath: ['ProcA'] })).status).toBe(400);
  });

  it('undoing line creation removes both the line and the concept description', async () => {
    const id = await company('WaceFactory');
    await node(id, { name: 'LineA', group: true, line: true });
    await h.call('POST', `/packages/${id}/undo`);
    expect(((await h.call('GET', `/packages/${id}/hierarchy`)).body as { children: TreeNode[] }).children).toEqual([]);
    expect(await lineConcepts(id)).toBe(0);
  });
});
