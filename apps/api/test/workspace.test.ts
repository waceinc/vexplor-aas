/**
 * Workspace isolation — across every entry point.
 *
 * Important: what this guards: **two people who logged in with the same trial account cannot see each other's files by any path.**
 *
 *    Checking only paths with a packageId in the URL is not enough. There are separate paths that **cross** packages —
 *    attaching another file to a hierarchy, importing a submodel from another file, a bundle finding the equipment
 *    tied to a process, the registry looking up by asset ID. Leaks usually happen there.
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { seedDemoUser, sweepVisitorFiles } from '../src/demo.js';
import { hashPassword } from '../src/password.js';
import type { ApiRequest } from '../src/http.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-roll-forming-machine.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));
const golden = readAasx(goldenBytes);
const shellId = golden.environment.assetAdministrationShells![0]!.id;
const submodelId = golden.environment.submodels![0]!.id;
const encode = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');

type Reply = { status: number; headers: Record<string, string>; body: any };
type Api = (request: ApiRequest) => Promise<Reply>;

const PASSWORD = '열자가넘는비밀번호입니다';
const DEMO = { login: 'admin', password: '1234', displayName: '체험 계정', role: 'editor' as const, resetMinutes: 60 };

/** One person — calls with a cookie (or API key) */
function person(api: Api, credential: { cookie?: string; token?: string } = {}) {
  return async (method: string, rawPath: string, body?: unknown): Promise<Reply> => {
    const [path, queryText] = rawPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(queryText ?? ''));
    const headers: Record<string, string> = {};
    if (credential.cookie) headers['cookie'] = credential.cookie;
    if (credential.token) headers['authorization'] = `Bearer ${credential.token}`;
    return api({
      method,
      path,
      query,
      queryAll: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, [value]])),
      headers,
      ...(body === undefined ? {} : { body }),
    } as ApiRequest);
  };
}

const cookieFrom = (reply: Reply): string => (reply.headers?.['set-cookie'] ?? '').split(';')[0] ?? '';

async function demoServer(): Promise<{ api: Api; store: InMemoryStore }> {
  const store = new InMemoryStore();
  await store.init();
  await seedDemoUser(store, DEMO, hashPassword);
  const api = createApi(store, {
    demo: DEMO,
    signup: { role: 'editor' },
    auth: { tokens: ['기계키'], readOnlyTokens: [] },
  }) as Api;
  return { api, store };
}

/** One visitor logged in with the trial account — every call is a **new login** */
async function visitor(api: Api) {
  const logged = await person(api)('POST', '/auth/login', { login: 'admin', password: '1234' });
  expect(logged.status).toBe(200);
  return person(api, { cookie: cookieFrom(logged) });
}

const upload = async (call: ReturnType<typeof person>, name = GOLDEN): Promise<string> => {
  const made = await call('POST', `/packages?name=${encodeURIComponent(name)}`, goldenBytes);
  expect(made.status).toBe(201);
  return made.body.packageId as string;
};

const listed = async (call: ReturnType<typeof person>): Promise<string[]> =>
  ((await call('GET', '/packages')).body.result as { packageId: string }[]).map((item) => item.packageId);

describe('Important: two visitors on the same trial account — cannot see each other\'s files', () => {
  it('not shown in the list', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const mine = await upload(alice);

    expect(await listed(alice)).toEqual([mine]);
    expect(await listed(bob)).toEqual([]);
  });

  it('knowing the URL does not open it — read · lint · download · edit · delete are all 404', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const id = await upload(alice);

    expect((await bob('GET', `/packages/${id}/lint`)).status).toBe(404);
    expect((await bob('GET', `/packages/${id}/report`)).status).toBe(404);
    expect((await bob('GET', `/packages/${id}`)).status).toBe(404);
    expect((await bob('GET', `/packages/${id}/api/v3.0/submodels`)).status).toBe(404);
    expect((await bob('GET', `/packages/${id}/history/${encode(submodelId)}`)).status).toBe(404);
    expect((await bob('PUT', `/packages/${id}/api/v3.0/submodels/${encode(submodelId)}`, { modelType: 'Submodel', id: submodelId })).status).toBe(404);
    expect((await bob('DELETE', `/packages/${id}`)).status).toBe(404);
    expect((await bob('POST', `/packages/${id}/fix`)).status).toBe(404);
    expect((await bob('POST', `/packages/${id}/undo`)).status).toBe(404);

    // And Alice's file is intact
    expect((await alice('GET', `/packages/${id}/lint`)).status).toBe(200);
  });

  it('Important: **the same answer** as a nonexistent file — otherwise one could probe ids and count other people\'s files', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const id = await upload(alice);

    const hidden = await bob('GET', `/packages/${id}/lint`);
    const missing = await bob('GET', '/packages/pkg_999/lint');
    expect(hidden.status).toBe(missing.status);
    expect(hidden.body.messages[0].code).toBe(missing.body.messages[0].code);
  });
});

describe('Important: things held outside the store — the undo list', () => {
  /*
   * The undo list lives not in the store but in **server memory**, keyed by package id. Since it
   * bypassed the store layer, at first one could read someone else's list, and attempting an undo wiped
   * that person's list. This test found that hole.
   */
  async function aliceEdited(): Promise<{ alice: ReturnType<typeof person>; bob: ReturnType<typeof person>; id: string }> {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const id = await upload(alice);
    const current = await alice('GET', `/packages/${id}/api/v3.0/submodels/${encode(submodelId)}`);
    const saved = await alice('PUT', `/packages/${id}/api/v3.0/submodels/${encode(submodelId)}`, {
      ...current.body,
      idShort: '앨리스가고침',
    });
    expect(saved.status).toBe(204);
    expect((await alice('GET', `/packages/${id}/undo`)).body.undo).toHaveLength(1);
    return { alice, bob, id };
  }

  it('cannot read another person\'s undo list — it records what they changed', async () => {
    const { bob, id } = await aliceEdited();
    expect((await bob('GET', `/packages/${id}/undo`)).status).toBe(404);
  });

  it('Important: attempting someone else\'s undo does not wipe that person\'s list', async () => {
    const { alice, bob, id } = await aliceEdited();
    expect((await bob('POST', `/packages/${id}/undo`)).status).toBe(404);
    expect((await bob('POST', `/packages/${id}/redo`)).status).toBe(404);
    // Alice can still undo
    expect((await alice('GET', `/packages/${id}/undo`)).body.undo).toHaveLength(1);
    expect((await alice('POST', `/packages/${id}/undo`)).status).toBe(200);
  });
});

describe('Important: no leaks through paths that cross packages either', () => {
  it('cannot attach someone else\'s file to a hierarchy', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const aliceMachine = await upload(alice);

    const line = (await bob('POST', '/packages/new', { assetName: 'BobLine', unit: 'composite' })).body.packageId;
    const linked = await bob('POST', `/packages/${line}/hierarchy/nodes`, { sourcePackageId: aliceMachine });
    expect(linked.status).toBe(404);
  });

  it('cannot import a submodel from someone else\'s file', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const aliceMachine = await upload(alice);
    const bobMachine = (await bob('POST', '/packages/new', { assetName: 'BobMachine', unit: 'equipment' })).body.packageId;

    const taken = await bob('POST', `/packages/${bobMachine}/import-submodel`, {
      sourcePackageId: aliceMachine,
      submodelId,
      onDuplicate: 'alongside',
    });
    expect(taken.status).toBe(404);
  });

  it('a bundle does not pull in someone else\'s equipment file — even with the same asset ID', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    await upload(alice); // Alice's roll forming machine

    // Bob creates a process pointing at the same asset (no file uploaded, just name and asset ID)
    const line = (await bob('POST', '/packages/new', { assetName: 'BobLine', unit: 'composite' })).body.packageId;
    const asset = String(golden.environment.assetAdministrationShells![0]!.assetInformation?.['globalAssetId' as never]);
    await bob('POST', `/packages/${line}/hierarchy/nodes`, { name: 'RollFormingMachine', globalAssetId: asset });

    const view = await bob('GET', `/packages/${line}/bundle/linkage`);
    expect(view.status).toBe(200);
    const member = view.body.members.find((item: any) => item.name === 'RollFormingMachine');
    // Important: Alice's file must not be attached — for Bob it must be "no file"
    expect(member.packageId).toBeUndefined();
  });

  it('someone else\'s AAS does not appear in the registry or search', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    await upload(alice);

    expect((await alice('GET', '/api/v3.0/shell-descriptors')).body.result).toHaveLength(1);
    expect((await bob('GET', '/api/v3.0/shell-descriptors')).body.result).toHaveLength(0);
    expect((await bob('GET', `/api/v3.0/shell-descriptors/${encode(shellId)}`)).status).toBe(404);
    expect((await bob('GET', '/api/v3.0/lookup/shells')).body.result).toHaveLength(0);
  });

  it('two people uploading the same file do not see each other as a "conflict"', async () => {
    // On the trial server everyone uploads the same sample file — dozens of identical AAS ids appear
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    await upload(alice);
    await upload(bob);
    expect((await alice('GET', '/registry-conflicts')).body.result ?? []).toHaveLength(0);
  });
});

describe('registered users · admins · machines', () => {
  it('registered users see only their own — still there after logging in again', async () => {
    const { api } = await demoServer();
    const joined = await person(api)('POST', '/auth/signup', { login: 'hong', password: PASSWORD });
    const hong = person(api, { cookie: cookieFrom(joined) });
    const mine = await upload(hong);

    const stranger = await visitor(api);
    await upload(stranger);
    expect(await listed(hong)).toEqual([mine]);

    // Important: unlike the trial account — the account is the key, so a new login gets the same space
    const again = await person(api)('POST', '/auth/login', { login: 'hong', password: PASSWORD });
    expect(await listed(person(api, { cookie: cookieFrom(again) }))).toEqual([mine]);
  });

  it('the trial account starts in an empty space on each new login — the login is the key', async () => {
    const { api } = await demoServer();
    const first = await visitor(api);
    await upload(first);
    const second = await visitor(api);
    expect(await listed(second)).toEqual([]);
  });

  it('API keys see everything — machine integration (registry · collection) handles the whole set', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const a = await upload(alice);
    const b = await upload(bob);
    const machine = person(api, { token: '기계키' });
    expect((await listed(machine)).sort()).toEqual([a, b].sort());
  });

  it('admins see everything — operating the server requires it', async () => {
    const { api, store } = await demoServer();
    await store.createUser({ login: 'owner', displayName: '주인', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const logged = await person(api)('POST', '/auth/login', { login: 'owner', password: PASSWORD });
    const owner = person(api, { cookie: cookieFrom(logged) });
    const alice = await visitor(api);
    const id = await upload(alice);
    expect(await listed(owner)).toContain(id);
    expect((await owner('GET', `/packages/${id}/lint`)).status).toBe(200);
  });
});

describe('shared files (no owner) — templates', () => {
  async function withTemplate(): Promise<{ api: Api; template: string }> {
    const { api, store } = await demoServer();
    // As if the server uploaded it at startup — outside a request, so there is no owner
    const template = (await store.importPackage({ name: '템플릿.aasx', package: readAasx(goldenBytes) })).id;
    return { api, template };
  }

  it('visible to every visitor and usable as an import source', async () => {
    const { api, template } = await withTemplate();
    const bob = await visitor(api);
    expect(await listed(bob)).toContain(template);

    const mine = (await bob('POST', '/packages/new', { assetName: 'BobMachine', unit: 'equipment' })).body.packageId;
    const taken = await bob('POST', `/packages/${mine}/import-submodel`, {
      sourcePackageId: template,
      submodelId,
      onDuplicate: 'replace',
    });
    expect(taken.status).toBeLessThan(300);
  });

  it('Important: visitors can neither edit nor delete it — if one deletes it, everyone loses it', async () => {
    const { api, template } = await withTemplate();
    const bob = await visitor(api);
    expect((await bob('DELETE', `/packages/${template}`)).status).toBe(403);
    const current = await bob('GET', `/packages/${template}/api/v3.0/submodels/${encode(submodelId)}`);
    expect(current.status).toBe(200);
    const changed = await bob('PUT', `/packages/${template}/api/v3.0/submodels/${encode(submodelId)}`, {
      ...current.body,
      idShort: '망가뜨림',
    });
    expect(changed.status).toBe(403);
    // Still visible as is to other visitors
    const carol = await visitor(api);
    expect(await listed(carol)).toContain(template);
  });
});

describe('visitor file cleanup', () => {
  it('Important: deletes only files of **visitors** unused for a while — registered users\' and shared files stay', async () => {
    const { api, store } = await demoServer();
    const template = (await store.importPackage({ name: '템플릿.aasx', package: readAasx(goldenBytes) })).id;
    const alice = await visitor(api);
    const visitorFile = await upload(alice);
    const joined = await person(api)('POST', '/auth/signup', { login: 'hong', password: PASSWORD });
    const memberFile = await upload(person(api, { cookie: cookieFrom(joined) }));

    // Run as if two hours have passed
    const removed = await sweepVisitorFiles(store, 60, Date.now() + 2 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    const left = (await store.listPackages()).items.map((item) => item.id);
    expect(left).not.toContain(visitorFile);
    expect(left).toContain(memberFile);
    expect(left).toContain(template);
  });

  it('does not delete recently used ones — deleting on the hour would make someone who just uploaded lose it', async () => {
    const { api, store } = await demoServer();
    const alice = await visitor(api);
    const id = await upload(alice);
    expect(await sweepVisitorFiles(store, 60)).toBe(0);
    expect((await store.listPackages()).items.map((item) => item.id)).toContain(id);
  });

  it('does not delete when 0', async () => {
    const { api, store } = await demoServer();
    await upload(await visitor(api));
    expect(await sweepVisitorFiles(store, 0, Date.now() + 10 * 24 * 60 * 60 * 1000)).toBe(0);
  });
});

describe('non-isolating server (default) — exactly as before', () => {
  it('Important: the team sees the same files together — this feature must not change in-house servers', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store) as Api;
    const made = await person(api)('POST', '/auth/setup', { login: 'owner', password: PASSWORD });
    const owner = person(api, { cookie: cookieFrom(made) });
    await owner('POST', '/auth/users', { login: 'kim', displayName: '김편집', role: 'editor', password: PASSWORD });
    const logged = await person(api)('POST', '/auth/login', { login: 'kim', password: PASSWORD });
    const kim = person(api, { cookie: cookieFrom(logged) });

    const id = await upload(owner);
    expect(await listed(kim)).toEqual([id]);
    expect((await kim('GET', `/packages/${id}/lint`)).status).toBe(200);
    // No owner is recorded either — even if isolation is turned on later, these files remain shared
    expect((await store.getPackage(id))?.owner).toBeUndefined();
  });

  it('when enabled (AAS_WORKSPACE=private) files are isolated even outside the trial edition', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { privateWorkspaces: true }) as Api;
    const made = await person(api)('POST', '/auth/setup', { login: 'owner', password: PASSWORD });
    const owner = person(api, { cookie: cookieFrom(made) });
    await owner('POST', '/auth/users', { login: 'kim', displayName: '김편집', role: 'editor', password: PASSWORD });
    await owner('POST', '/auth/users', { login: 'lee', displayName: '이편집', role: 'editor', password: PASSWORD });
    const kim = person(api, { cookie: cookieFrom(await person(api)('POST', '/auth/login', { login: 'kim', password: PASSWORD })) });
    const lee = person(api, { cookie: cookieFrom(await person(api)('POST', '/auth/login', { login: 'lee', password: PASSWORD })) });

    const id = await upload(kim);
    expect(await listed(lee)).toEqual([]);
    expect(await listed(owner)).toEqual([id]); // admins can see it
  });
});
