/**
 * Process-level API.
 *
 * Important: the point of this test: **does equipment attach just by picking its file?**
 * Making people copy the name and Asset address by hand is where typos creep in —
 * that link is the only connection between the process file and the equipment file, so if it is wrong it breaks silently.
 *
 * And **does it leave the equipment file intact?** Process features must not change equipment-side behavior.
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
    // Strip query parameters like the real server (toApiRequest) does — otherwise path matching fails and it becomes 404
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

describe('creating a process', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.store.init();
  });

  it('with unit=process it is born with the hierarchy filled in', async () => {
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

  it('has 0 violations right from birth', async () => {
    const created = await h.call('POST', '/packages/new', {
      assetName: 'WeldingProcess',
      unit: 'process',
    });
    const lint = await h.call('GET', `/packages/${created.body.packageId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('without unit it is equipment as before — existing behavior is unchanged', async () => {
    const created = await h.call('POST', '/packages/new', { assetName: 'TestMachine' });
    const hierarchy = await h.call('GET', `/packages/${created.body.packageId}/hierarchy`);
    expect(hierarchy.body.entryNode).toBeNull();
  });
});

describe('attaching equipment', () => {
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

  it('picking uploaded equipment reads the name and Asset address from that file', async () => {
    const added = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
    });
    expect(added.status).toBe(201);
    expect(added.body.name).toBe('RollFormingMachine');
    expect(added.body.globalAssetId).toBe(
      'https://www.smart-factory.kr/ids/asset/RollFormingMachine/1/0',
    );
  });

  it('has no violations even with two units attached', async () => {
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

  it('can also be entered by hand — for listing equipment that has no file yet', async () => {
    const added = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      name: 'FuturePress',
      globalAssetId: 'https://www.smart-factory.kr/ids/asset/FuturePress/1/0',
      bulkCount: 3,
    });
    expect(added.status).toBe(201);
    const hierarchy = await h.call('GET', `/packages/${processId}/hierarchy`);
    expect(hierarchy.body.children[0].bulkCount).toBe(3);
  });

  it('cannot attach the same equipment twice', async () => {
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machineId });
    const again = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
    });
    expect(again.status).toBe(400);
  });

  it('cannot attach itself', async () => {
    const self = await h.call('POST', `/packages/${processId}/hierarchy/nodes`, {
      sourcePackageId: processId,
    });
    expect(self.status).toBe(400);
  });

  it('removing it also removes the relationship — no violations remain', async () => {
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: machineId });
    await h.call('POST', `/packages/${processId}/hierarchy/nodes`, { sourcePackageId: robotId });

    const removed = await h.call('DELETE', `/packages/${processId}/hierarchy/nodes/RollFormingMachine`);
    expect(removed.status).toBe(204);

    const hierarchy = await h.call('GET', `/packages/${processId}/hierarchy`);
    expect(hierarchy.body.children.map((c: any) => c.name)).toEqual(['CollabRobot6Axis']);
    const lint = await h.call('GET', `/packages/${processId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('removing something that does not exist is 404', async () => {
    const removed = await h.call('DELETE', `/packages/${processId}/hierarchy/nodes/NoSuchThing`);
    expect(removed.status).toBe(404);
  });

  it('the hierarchy of an equipment file is readable too — equipment also has a part hierarchy', async () => {
    const hierarchy = await h.call('GET', `/packages/${machineId}/hierarchy`);
    expect(hierarchy.body.entryNode.name).toBe('RollFormingMachine');
    expect(hierarchy.body.children.map((c: any) => c.name)).toEqual([
      'Uncoiler',
      'RollStandUnit',
      'CutOffPress',
    ]);
    // BulkCount is read as is (12 RollStandUnits)
    expect(hierarchy.body.children[1].bulkCount).toBe(12);
  });
});

/**
 * History and undo.
 *
 * Important: the point: **can mistakes be recovered?** The store had accumulated pre-change content from the start,
 * but there was no way to get it back out — a hole found in real-use validation (building one ourselves).
 * Undo itself must also be recorded in history — being able to undo an undo is what makes it a safety net.
 */
describe('history and undo', () => {
  let h: ReturnType<typeof harness>;
  let packageId: string;
  const SM = 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/TechnicalData/2/1';
  const encode = (text: string): string => Buffer.from(text).toString('base64url');

  beforeEach(async () => {
    h = harness();
    await h.store.init();
    packageId = (await h.store.importPackage({ name: 'g.aasx', package: golden() })).id;
  });

  it('editing creates history, and you can revert to that revision', async () => {
    const before = await h.store.getIdentifiable(packageId, 'Submodel', SM);
    const beforeCount = (before!.content['submodelElements'] as unknown[]).length;

    // Destructive edit that clears every element (mistake scenario)
    await h.store.updateIdentifiable(packageId, 'Submodel', SM, {
      ...before!.content,
      submodelElements: [{ idShort: 'Oops', modelType: 'Property', valueType: 'xs:string' }],
    });

    const history = await h.call('GET', `/packages/${packageId}/history/${encode(SM)}`);
    expect(history.status).toBe(200);
    expect(history.body.result).toHaveLength(1);
    // elementCount is a recursive total (including descendants), so it exceeds the top-level count — only check that it exists
    expect(history.body.result[0].elementCount).toBeGreaterThan(beforeCount);

    // Revert
    const restored = await h.call(
      'POST',
      `/packages/${packageId}/history/${encode(SM)}/restore`,
      { changedAt: history.body.result[0].changedAt },
    );
    expect(restored.status).toBe(200);
    const after = await h.store.getIdentifiable(packageId, 'Submodel', SM);
    expect((after!.content['submodelElements'] as unknown[]).length).toBe(beforeCount);

    // Important: the revert itself is recorded in history — a revert can be reverted again
    const again = await h.call('GET', `/packages/${packageId}/history/${encode(SM)}`);
    expect(again.body.result).toHaveLength(2);
  });

  it('reverting to a nonexistent timestamp is 404', async () => {
    const bad = await h.call(
      'POST',
      `/packages/${packageId}/history/${encode(SM)}/restore`,
      { changedAt: '2000-01-01T00:00:00.000Z' },
    );
    expect(bad.status).toBe(404);
  });
});

/**
 * Company level and cycle prevention.
 * The hierarchy is recursive (RAMI 4.0: enterprise → factory → station → equipment) — a company has the same structure as a process,
 * only the label (assetType) differs. Once it became recursive, a cycle (A⊃B⊃A) became a mistake that can
 * actually be made — the server has to block it.
 */
describe('company level and cycle prevention', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.store.init();
  });

  it('creating a company adds only the hierarchy, with 0 violations', async () => {
    const created = await h.call('POST', '/packages/new', {
      assetName: 'OurFactory',
      unit: 'company',
    });
    expect(created.status).toBe(201);
    const lint = await h.call('GET', `/packages/${created.body.packageId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('company → process → (cycle attempt) adding the company is 400', async () => {
    const company = (
      await h.call('POST', '/packages/new', { assetName: 'OurFactory', unit: 'company' })
    ).body.packageId;
    const line = (
      await h.call('POST', '/packages/new', { assetName: 'PressLine', unit: 'process' })
    ).body.packageId;

    // Add the process to the company — normal
    const ok = await h.call('POST', `/packages/${company}/hierarchy/nodes`, {
      sourcePackageId: line,
    });
    expect(ok.status).toBe(201);

    // Trying to add the company to the process — that is a cycle
    const cycle = await h.call('POST', `/packages/${line}/hierarchy/nodes`, {
      sourcePackageId: company,
    });
    expect(cycle.status).toBe(400);
    expect(JSON.stringify(cycle.body)).toContain('순환');
  });
});

/**
 * Nesting within one file — company > process > machine.
 *
 * Important: the point: no need to create a file per level. Create a group (CoManagedEntity — an intermediate node with no file)
 * and put equipment under it. Same syntax as the part nesting in the golden file.
 */
describe('nesting within one file (groups)', () => {
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

  it('creating a group and putting equipment under it yields a nested tree', async () => {
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
    expect(process.globalAssetId).toBe(''); // a group has no file
    expect(process.children[0].name).toBe('RollFormingMachine');
    expect(process.children[0].bulkCount).toBe(2);

    // It must also pass the rules — CoManagedEntity may lack a globalAssetId (AASd-014)
    const lint = await h.call('GET', `/packages/${companyId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('the same equipment can go into different groups — but not twice into the same group', async () => {
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
    expect(other.status).toBe(201); // same model in another process — this really happens
    const dup = await h.call('POST', `/packages/${companyId}/hierarchy/nodes`, {
      sourcePackageId: machineId,
      parentPath: ['ProcA'],
    });
    expect(dup.status).toBe(400); // not twice in the same spot
  });

  it('groups within groups work, and deep levels also have the globalAssetId key', async () => {
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
    // Important: if the key is missing the UI mistakes the group for equipment — a bug caught by real measurement
    expect(sub.globalAssetId).toBe('');
    expect(sub.children[0].name).toBe('RollFormingMachine');
    expect(typeof sub.children[0].globalAssetId).toBe('string');
    const lint = await h.call('GET', `/packages/${companyId}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);
  });

  it('a nested child can be removed by path — the relationship goes with it', async () => {
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
 * Self-contradiction regression for collection connections (AID) — what the tool creates must not violate the tool's own rules.
 * Observed (2026-08-26 expert demo): using the IDTA IRI directly as semanticId made it born with
 * 13 KOSMO-SME-3 violations, and migrating via "fix" made the IDTA marking disappear.
 */
describe('AID follows the rules right from birth', () => {
  it('created with 0 violations, and the IDTA original remains as supplemental', async () => {
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
    // Own IRI as semanticId, IDTA as supplemental — the kosmo-first pairing (same pattern as the hierarchy)
    expect(iface.semanticId.keys[0].value).toContain('smart-factory.kr/ids/cd/');
    expect(iface.supplementalSemanticIds[0].keys[0].value).toContain('admin-shell.io/idta');
  });

  /**
   * Important: the **other half** of a collection connection — values only go out once the slots for the tags are built too.
   * And what is built that way must also **follow the rules right from birth**. Same reason as the test above.
   */
  it('building the slots too still gives 0 violations and keeps the KTL hierarchy', async () => {
    const h = harness();
    await h.store.init();
    const pid = (await h.store.importPackage({ name: 'g.aasx', package: golden() })).id;

    const made = await h.call('POST', `/packages/${pid}/aid`, {
      endpoint: 'opc.tcp://127.0.0.1:14840/UA/Test',
      tags: [
        { name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float', unit: 'rpm' },
        // Important: **a real-number tag without a unit.** Since the unit field was removed from the UI, this is actually the common case —
        //    we left it out of the test and produced 3 AASc-3a-009 violations without noticing (observed)
        { name: 'MotorTemperature', href: 'ns=1;s=Machine.Temp', type: 'float' },
        // A name that already exists in the golden file — must not be touched
        { name: 'CurrentLineSpeed', href: 'ns=1;s=Machine.Line', type: 'float' },
      ],
      createMissing: { group: 'ProcessMonitoring', subgroup: 'CollectedValues' },
    });
    expect(made.status).toBe(201);
    expect(made.body.elementsAdded).toEqual(['MotorSpeed', 'MotorTemperature']);
    // The slots are built, so names do not drift = values go out through the standard API
    expect(made.body.nameMisses).toEqual([]);

    // What the tool creates must not violate the tool's own rules
    const lint = await h.call('GET', `/packages/${pid}/lint`);
    expect(lint.body.countBySeverity.error ?? 0).toBe(0);

    const submodels = await h.call('GET', `/packages/${pid}/api/v3.0/submodels`);
    const od = submodels.body.result.find(
      (sm: { idShort?: string }) => sm.idShort === 'OperationalData',
    )!;

    // KTL hierarchy: OperationalData > major category > minor category > Property (docs/rules/01 §2-2)
    const group = od.submodelElements.find(
      (n: { idShort?: string }) => n.idShort === 'ProcessMonitoring',
    )!;
    const sub = group.value.find((n: { idShort?: string }) => n.idShort === 'CollectedValues')!;
    const prop = sub.value.find((n: { idShort?: string }) => n.idShort === 'MotorSpeed')!;
    expect(prop.modelType).toBe('Property');
    expect(prop.valueType).toBe('xs:double');
    // Important: if the key type is wrong, basyx drops the whole submodel — it must have the same shape as the golden file
    expect(prop.semanticId.type).toBe('ModelReference');
    expect(prop.semanticId.keys[0].type).toBe('ConceptDescription');
    // Important: sample data goes in, because KOSMO-SME-4 treats empty values as violations —
    //    it is the Template's sample field, not a measured value, and is overwritten by live/OPC UA once collection is attached
    expect(prop.value).toBe('0.0');

    // Important: what already existed stays as is. The golden file's CurrentLineSpeed remains in place, value included
    const forming = group.value.find(
      (n: { idShort?: string }) => n.idShort === 'FormingParameter',
    )!;
    const kept = forming.value.find(
      (n: { idShort?: string }) => n.idShort === 'CurrentLineSpeed',
    )!;
    expect(kept.value).toBe('18.5');
  });
});
