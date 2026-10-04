/**
 * 작업 공간 분리 — 문 전체에서.
 *
 * 🔴 지키는 것: **같은 체험 계정으로 들어온 두 사람이 서로의 파일을 어떤 길로도 보지 못한다.**
 *
 *    주소에 packageId가 든 길만 보면 안 된다. 패키지를 **가로지르는** 길이 따로 있다 —
 *    계층에 다른 파일을 이어 붙일 때, 다른 파일에서 서브모델을 가져올 때, 번들이 공정에
 *    묶인 설비를 찾을 때, 레지스트리가 자산 ID로 찾을 때. 새는 것은 대개 그쪽이다.
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
const GOLDEN = '01-롤포밍기-공34.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));
const golden = readAasx(goldenBytes);
const shellId = golden.environment.assetAdministrationShells![0]!.id;
const submodelId = golden.environment.submodels![0]!.id;
const encode = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');

type Reply = { status: number; headers: Record<string, string>; body: any };
type Api = (request: ApiRequest) => Promise<Reply>;

const PASSWORD = '열자가넘는비밀번호입니다';
const DEMO = { login: 'admin', password: '1234', displayName: '체험 계정', role: 'editor' as const, resetMinutes: 60 };

/** 한 사람 — 쿠키(또는 API 키)를 들고 부른다 */
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

/** 체험 계정으로 들어온 방문자 한 명 — 부를 때마다 **새 로그인**이다 */
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

describe('🔴 같은 체험 계정의 두 방문자 — 서로의 파일을 못 본다', () => {
  it('목록에 안 나온다', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const mine = await upload(alice);

    expect(await listed(alice)).toEqual([mine]);
    expect(await listed(bob)).toEqual([]);
  });

  it('주소를 알아도 열리지 않는다 — 읽기·검사·내려받기·고치기·지우기 전부 404', async () => {
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

    // 그리고 앨리스의 파일은 멀쩡하다
    expect((await alice('GET', `/packages/${id}/lint`)).status).toBe(200);
  });

  it('🔴 없는 파일과 **같은 답**이다 — 다르면 id를 찍어 보며 남의 파일을 셀 수 있다', async () => {
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

describe('🔴 저장소 밖에 든 것 — 되돌리기 목록', () => {
  /*
   * 되돌리기 목록은 저장소가 아니라 **서버 메모리**에 패키지 id로 들어 있다. 저장소 겹을
   * 거치지 않아, 처음에는 남의 목록을 읽을 수 있었고 되돌리기를 시도하면 그 사람의 목록이
   * 지워졌다. 이 시험이 그 구멍을 찾았다.
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

  it('남의 되돌리기 목록을 읽지 못한다 — 무엇을 고쳤는지가 거기 적혀 있다', async () => {
    const { bob, id } = await aliceEdited();
    expect((await bob('GET', `/packages/${id}/undo`)).status).toBe(404);
  });

  it('🔴 남의 되돌리기를 시도해도 그 사람의 목록이 지워지지 않는다', async () => {
    const { alice, bob, id } = await aliceEdited();
    expect((await bob('POST', `/packages/${id}/undo`)).status).toBe(404);
    expect((await bob('POST', `/packages/${id}/redo`)).status).toBe(404);
    // 앨리스는 여전히 되돌릴 수 있다
    expect((await alice('GET', `/packages/${id}/undo`)).body.undo).toHaveLength(1);
    expect((await alice('POST', `/packages/${id}/undo`)).status).toBe(200);
  });
});

describe('🔴 패키지를 가로지르는 길로도 새지 않는다', () => {
  it('계층에 남의 파일을 이어 붙이지 못한다', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const aliceMachine = await upload(alice);

    const line = (await bob('POST', '/packages/new', { assetName: 'BobLine', unit: 'composite' })).body.packageId;
    const linked = await bob('POST', `/packages/${line}/hierarchy/nodes`, { sourcePackageId: aliceMachine });
    expect(linked.status).toBe(404);
  });

  it('남의 파일에서 서브모델을 가져오지 못한다', async () => {
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

  it('번들이 남의 설비 파일을 끌어오지 않는다 — 자산 ID가 같아도', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    await upload(alice); // 앨리스의 롤포밍기

    // 밥이 같은 자산을 가리키는 공정을 만든다(파일은 안 올리고 이름·자산 ID만)
    const line = (await bob('POST', '/packages/new', { assetName: 'BobLine', unit: 'composite' })).body.packageId;
    const asset = String(golden.environment.assetAdministrationShells![0]!.assetInformation?.['globalAssetId' as never]);
    await bob('POST', `/packages/${line}/hierarchy/nodes`, { name: 'RollFormingMachine', globalAssetId: asset });

    const view = await bob('GET', `/packages/${line}/bundle/linkage`);
    expect(view.status).toBe(200);
    const member = view.body.members.find((item: any) => item.name === 'RollFormingMachine');
    // 🔴 앨리스의 파일이 붙으면 안 된다 — 밥에게는 「파일 없음」이어야 한다
    expect(member.packageId).toBeUndefined();
  });

  it('레지스트리·찾기에 남의 AAS가 나오지 않는다', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    await upload(alice);

    expect((await alice('GET', '/api/v3.0/shell-descriptors')).body.result).toHaveLength(1);
    expect((await bob('GET', '/api/v3.0/shell-descriptors')).body.result).toHaveLength(0);
    expect((await bob('GET', `/api/v3.0/shell-descriptors/${encode(shellId)}`)).status).toBe(404);
    expect((await bob('GET', '/api/v3.0/lookup/shells')).body.result).toHaveLength(0);
  });

  it('둘이 같은 파일을 올려도 서로 「충돌」로 보이지 않는다', async () => {
    // 체험 서버에서는 모두가 같은 예제 파일을 올린다 — 같은 AAS id가 수십 개 생긴다
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    await upload(alice);
    await upload(bob);
    expect((await alice('GET', '/registry-conflicts')).body.result ?? []).toHaveLength(0);
  });
});

describe('가입한 사람 · 관리자 · 기계', () => {
  it('가입한 사람은 자기 것만 본다 — 다시 로그인해도 그대로 있다', async () => {
    const { api } = await demoServer();
    const joined = await person(api)('POST', '/auth/signup', { login: 'hong', password: PASSWORD });
    const hong = person(api, { cookie: cookieFrom(joined) });
    const mine = await upload(hong);

    const stranger = await visitor(api);
    await upload(stranger);
    expect(await listed(hong)).toEqual([mine]);

    // 🔴 체험 계정과 다르다 — 계정이 열쇠라 로그인을 새로 해도 같은 칸이다
    const again = await person(api)('POST', '/auth/login', { login: 'hong', password: PASSWORD });
    expect(await listed(person(api, { cookie: cookieFrom(again) }))).toEqual([mine]);
  });

  it('체험 계정은 로그인을 새로 하면 빈 칸에서 시작한다 — 로그인이 열쇠다', async () => {
    const { api } = await demoServer();
    const first = await visitor(api);
    await upload(first);
    const second = await visitor(api);
    expect(await listed(second)).toEqual([]);
  });

  it('API 키는 전부 본다 — 기계 연동(레지스트리·수집)은 전체를 다룬다', async () => {
    const { api } = await demoServer();
    const alice = await visitor(api);
    const bob = await visitor(api);
    const a = await upload(alice);
    const b = await upload(bob);
    const machine = person(api, { token: '기계키' });
    expect((await listed(machine)).sort()).toEqual([a, b].sort());
  });

  it('관리자는 전부 본다 — 운영하려면 봐야 한다', async () => {
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

describe('함께 쓰는 파일(주인 없음) — 템플릿', () => {
  async function withTemplate(): Promise<{ api: Api; template: string }> {
    const { api, store } = await demoServer();
    // 서버가 기동 때 올린 것처럼 — 요청 밖이라 주인이 없다
    const template = (await store.importPackage({ name: '템플릿.aasx', package: readAasx(goldenBytes) })).id;
    return { api, template };
  }

  it('모든 방문자에게 보이고, 가져오기의 출처가 된다', async () => {
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

  it('🔴 방문자는 고치지도 지우지도 못한다 — 하나가 지우면 모두가 잃는다', async () => {
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
    // 다른 방문자에게 여전히 그대로 보인다
    const carol = await visitor(api);
    expect(await listed(carol)).toContain(template);
  });
});

describe('방문자 파일 정리', () => {
  it('🔴 한동안 안 쓴 **방문자의** 파일만 지운다 — 가입한 사람·공용은 남긴다', async () => {
    const { api, store } = await demoServer();
    const template = (await store.importPackage({ name: '템플릿.aasx', package: readAasx(goldenBytes) })).id;
    const alice = await visitor(api);
    const visitorFile = await upload(alice);
    const joined = await person(api)('POST', '/auth/signup', { login: 'hong', password: PASSWORD });
    const memberFile = await upload(person(api, { cookie: cookieFrom(joined) }));

    // 두 시간 뒤라고 치고 돌린다
    const removed = await sweepVisitorFiles(store, 60, Date.now() + 2 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    const left = (await store.listPackages()).items.map((item) => item.id);
    expect(left).not.toContain(visitorFile);
    expect(left).toContain(memberFile);
    expect(left).toContain(template);
  });

  it('방금 쓴 것은 지우지 않는다 — 정각마다 지우면 방금 올린 사람이 잃는다', async () => {
    const { api, store } = await demoServer();
    const alice = await visitor(api);
    const id = await upload(alice);
    expect(await sweepVisitorFiles(store, 60)).toBe(0);
    expect((await store.listPackages()).items.map((item) => item.id)).toContain(id);
  });

  it('0이면 지우지 않는다', async () => {
    const { api, store } = await demoServer();
    await upload(await visitor(api));
    expect(await sweepVisitorFiles(store, 0, Date.now() + 10 * 24 * 60 * 60 * 1000)).toBe(0);
  });
});

describe('나누지 않는 서버(기본) — 예전과 똑같다', () => {
  it('🔴 팀이 같은 파일을 같이 본다 — 이 기능이 생겼다고 사내 서버가 달라지면 안 된다', async () => {
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
    // 주인도 적히지 않는다 — 나중에 나누기를 켜도 이 파일들은 공용으로 남는다
    expect((await store.getPackage(id))?.owner).toBeUndefined();
  });

  it('켜면(AAS_WORKSPACE=private) 체험판이 아니어도 나뉜다', async () => {
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
    expect(await listed(owner)).toEqual([id]); // 관리자는 본다
  });
});
