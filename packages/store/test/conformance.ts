/**
 * 저장소 적합성 테스트 — InMemoryStore와 PostgresStore에 **같은 시나리오**를 돌린다.
 *
 * 구현이 둘이라는 사실 자체가 위험이다(개발은 인메모리로 하고 운영은 Postgres로 도는 상황).
 * 여기서 갈리면 바로 깨지도록 한 벌만 쓴다.
 */
import { readAasx, writeAasx } from '@aas/aasx';
import { canonicalJson } from '@aas/core';
import { ALL_RULES, lint } from '@aas/linter';
import {
  ConflictError,
  InvalidContentError,
  NotFoundError,
  runAsActor,
  type AasStore,
} from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-롤포밍기-공34.aasx';

function loadGolden(): ReturnType<typeof readAasx> {
  return readAasx(new Uint8Array(readFileSync(root + GOLDEN)));
}

/** 구현 하나에 대한 전체 시나리오 */
export function describeStore(name: string, create: () => Promise<AasStore>): void {
  describe(`${name} — 저장소 적합성`, () => {
    let golden: ReturnType<typeof readAasx>;
    beforeAll(() => {
      golden = loadGolden();
    });

    /** 골든 파일을 담은 새 저장소를 만든다 */
    async function seeded(): Promise<{ store: AasStore; packageId: string }> {
      const store = await create();
      await store.init();
      const record = await store.importPackage({ name: GOLDEN, package: golden });
      return { store, packageId: record.id };
    }

    it('무손실 왕복 — import → export 후 원본 Environment와 의미적으로 같다', async () => {
      const { store, packageId } = await seeded();
      const exported = await store.exportPackage(packageId);
      expect(canonicalJson(exported.environment)).toBe(canonicalJson(golden.environment));
      expect(exported.specPart).toBe(golden.specPart);
    });

    it('무손실 왕복 — 썸네일·첨부·기타 파트가 그대로 살아난다', async () => {
      const { store, packageId } = await seeded();
      const exported = await store.exportPackage(packageId);

      expect(exported.thumbnail?.part).toBe(golden.thumbnail?.part);
      expect(exported.thumbnail?.contentType).toBe(golden.thumbnail?.contentType);
      expect(exported.thumbnail?.data).toEqual(golden.thumbnail?.data);
      expect(exported.supplementaryFiles.map((f) => f.part).sort()).toEqual(
        golden.supplementaryFiles.map((f) => f.part).sort(),
      );
      expect([...exported.extraParts.keys()].sort()).toEqual([...golden.extraParts.keys()].sort());
    });

    it('Phase 2 검수 기준 — 저장소를 거쳐 다시 저장해도 위반 0건이다', async () => {
      const { store, packageId } = await seeded();
      const exported = await store.exportPackage(packageId);
      const reread = readAasx(writeAasx(exported));
      const result = lint(reread.environment, ALL_RULES, { package: reread.opc });
      expect(result.countBySeverity.error).toBe(0);
      expect(canonicalJson(reread.environment)).toBe(canonicalJson(golden.environment));
    });

    it('Identifiable 목록은 원본 배열 순서를 지킨다', async () => {
      const { store, packageId } = await seeded();
      const submodels = await store.listIdentifiables(packageId, 'Submodel');
      expect(submodels.items.map((r) => r.idShort)).toEqual(
        golden.environment.submodels!.map((s) => s.idShort),
      );
    });

    it('조회용 컬럼을 파생해 둔다 (idShort · kind · semanticId · assetKind)', async () => {
      const { store, packageId } = await seeded();
      const dn = await store.getIdentifiable(
        packageId,
        'Submodel',
        golden.environment.submodels![0]!.id,
      );
      expect(dn?.idShort).toBe('DigitalNameplate');
      expect(dn?.kind).toBe('Template');
      expect(dn?.semanticId).toBe(golden.environment.submodels![0]!.semanticId!.keys[0]!.value);

      const shells = await store.listIdentifiables(packageId, 'AssetAdministrationShell');
      expect(shells.items[0]?.assetKind).toBe('Type');
    });

    it('페이지네이션 — cursor로 이어 받으면 전량이 한 번씩 나온다', async () => {
      const { store, packageId } = await seeded();
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listIdentifiables(packageId, 'ConceptDescription', {
          limit: 20,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((r) => r.uid));
        cursor = page.cursor;
      } while (cursor);

      expect(seen.length).toBe(golden.environment.conceptDescriptions!.length);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('자리를 지정해 넣을 수 있다 — 지운 자리에 새것을 놓아 순서를 지킨다(2026-09-07)', async () => {
      const { store, packageId } = await seeded();
      const first = (await store.listIdentifiables(packageId, 'Submodel')).items[0]!;
      const seat = first.ordinal;
      await store.deleteIdentifiable(packageId, 'Submodel', first.id);
      const created = await store.createIdentifiable(
        packageId,
        { ...first.content, id: `${first.id}-again` },
        { ordinal: seat },
      );
      expect(created.ordinal).toBe(seat);
      const after = await store.listIdentifiables(packageId, 'Submodel');
      expect(after.items[0]!.id).toBe(`${first.id}-again`);
      // 자리를 안 주면 여전히 맨 뒤
      const tail = await store.createIdentifiable(packageId, { ...first.content, id: `${first.id}-tail` });
      expect(tail.ordinal).toBeGreaterThan(Math.max(...after.items.map((r) => r.ordinal)));
    });

    it('CRUD — 만들고 고치고 지운다', async () => {
      const { store, packageId } = await seeded();
      const created = await store.createIdentifiable(packageId, {
        modelType: 'Submodel',
        id: 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/Extra/1/0',
        idShort: 'Extra',
        kind: 'Template',
        submodelElements: [],
      });
      expect(created.revision).toBe(1);
      expect(created.idShort).toBe('Extra');

      const updated = await store.updateIdentifiable(
        packageId,
        'Submodel',
        created.id,
        { ...created.content, idShort: 'ExtraRenamed' },
        { expectedRevision: 1 },
      );
      expect(updated.revision).toBe(2);
      expect(updated.idShort).toBe('ExtraRenamed');
      // 파생 컬럼만이 아니라 원본 JSON도 함께 바뀐다
      expect((updated.content as { idShort: string }).idShort).toBe('ExtraRenamed');

      await store.deleteIdentifiable(packageId, 'Submodel', created.id);
      expect(await store.getIdentifiable(packageId, 'Submodel', created.id)).toBeUndefined();
    });

    it('버전 이력 — 변경 전 내용이 남고 최신이 앞에 온다', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      await store.updateIdentifiable(packageId, 'Submodel', target.id, {
        ...current.content,
        idShort: '1차수정',
      });
      await store.updateIdentifiable(packageId, 'Submodel', target.id, {
        ...current.content,
        idShort: '2차수정',
      });

      const history = await store.history(packageId, 'Submodel', target.id);
      expect(history).toHaveLength(2);
      expect((history[0]!.content as { idShort: string }).idShort).toBe('1차수정');
      expect((history[1]!.content as { idShort: string }).idShort).toBe('DigitalNameplate');
      expect(history[0]!.operation).toBe('update');
      // 「누가」를 안 준 변경은 **비어 있다** — 없는 사실을 지어내지 않는다
      expect(history[0]!.actorId).toBeUndefined();
      expect(history[0]!.actorName).toBeUndefined();
    });

    it('패키지의 주인 — 안 주면 공용이고, 준 것은 그대로 돌아온다', async () => {
      const { store, packageId } = await seeded();
      // 🔴 주인을 안 준 것은 키 자체가 없다 — 「공용」과 「주인이 빈 값」을 섞지 않는다
      expect((await store.getPackage(packageId))?.owner).toBeUndefined();

      const mine = await store.importPackage({ name: '내것.aasx', package: golden, owner: 'user:a' });
      expect(mine.owner).toBe('user:a');
      expect((await store.getPackage(mine.id))?.owner).toBe('user:a');
      // null은 「일부러 공용」 — 공용 파일을 통째로 바꿀 때 공용으로 남기는 데 쓴다
      const shared = await store.importPackage({ name: '공용.aasx', package: golden, owner: null });
      expect(shared.owner).toBeUndefined();
    });

    it('🔴 목록을 주인으로 거른다 — 내 것과 공용만, 남의 것은 안 나온다', async () => {
      const { store, packageId } = await seeded(); // 공용 하나
      const a = await store.importPackage({ name: 'a.aasx', package: golden, owner: 'user:a' });
      const b = await store.importPackage({ name: 'b.aasx', package: golden, owner: 'user:b' });

      const seenByA = (await store.listPackages({}, { owner: 'user:a' })).items.map((item) => item.id);
      expect(seenByA).toContain(a.id);
      expect(seenByA).toContain(packageId);
      expect(seenByA).not.toContain(b.id);

      // 범위를 안 주면 전부 — 서버 자신(수집·정리)이 이렇게 본다
      expect((await store.listPackages()).items).toHaveLength(3);
    });

    it('🔴 거른 뒤에 쪽을 나눈다 — 밖에서 거르면 한 쪽이 덜 차고 다음 쪽 유무가 틀린다', async () => {
      const { store } = await seeded(); // 공용 1
      // 남의 것과 내 것을 번갈아 넣는다 — id 순서로 섞이게
      const mine: string[] = [];
      for (let n = 0; n < 4; n += 1) {
        await store.importPackage({ name: `남${n}.aasx`, package: golden, owner: 'user:b' });
        mine.push((await store.importPackage({ name: `내${n}.aasx`, package: golden, owner: 'user:a' })).id);
      }
      // 내 것 4 + 공용 1 = 5건을 2건씩 받는다
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.listPackages(cursor === undefined ? { limit: 2 } : { limit: 2, cursor }, { owner: 'user:a' });
        // 마지막 쪽이 아니면 **꽉 차 있어야** 한다
        if (page.cursor !== undefined) expect(page.items).toHaveLength(2);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.cursor;
        pages += 1;
      } while (cursor !== undefined);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      for (const id of mine) expect(seen).toContain(id);
      expect(pages).toBe(3);
    });

    it('계정을 지운다(탈퇴) — 없는 것을 지우면 false', async () => {
      const { store } = await seeded();
      const made = await store.createUser({
        login: 'hong', displayName: '홍길동', role: 'editor', passwordHash: 'h',
      });
      expect(await store.deleteUser(made.id)).toBe(true);
      expect(await store.getUser(made.id)).toBeUndefined();
      expect(await store.findUserByLogin('hong')).toBeUndefined();
      // 같은 이름으로 다시 가입할 수 있어야 한다 — 지웠으니 자리가 비었다
      expect((await store.createUser({
        login: 'hong', displayName: '다른 사람', role: 'viewer', passwordHash: 'h',
      })).login).toBe('hong');
      expect(await store.deleteUser('user_없음')).toBe(false);
    });

    it('🔴 계정을 지워도 그 사람이 남긴 이력은 남는다 — 감사 기록이 소급해 사라지면 안 된다', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;
      const made = await store.createUser({
        login: 'hong', displayName: '홍길동', role: 'editor', passwordHash: 'h',
      });
      await runAsActor({ id: made.id, name: made.displayName }, async () => {
        await store.updateIdentifiable(packageId, 'Submodel', target.id, {
          ...current.content,
          idShort: '고침',
        });
      });

      await store.deleteUser(made.id);

      const history = await store.history(packageId, 'Submodel', target.id);
      expect(history[0]?.actorName).toBe('홍길동');
      expect(history[0]?.actorId).toBe(made.id);
    });

    it('연락처는 선택이다 — 안 적으면 아예 없고, 빈 문자열로 지울 수 있다', async () => {
      const { store } = await seeded();
      const none = await store.createUser({
        login: 'a', displayName: 'A', role: 'editor', passwordHash: 'h',
      });
      // 🔴 「안 적었다」와 「빈 값을 적었다」를 섞지 않는다
      expect(none.email).toBeUndefined();

      const some = await store.createUser({
        login: 'b', displayName: 'B', role: 'editor', passwordHash: 'h', email: ' b@example.com ',
      });
      expect(some.email).toBe('b@example.com');
      expect((await store.findUserByLogin('b'))?.email).toBe('b@example.com');

      // 빈 문자열은 「지우라」는 뜻 — 개인정보를 빼 달라는 요구에 쓰인다
      expect((await store.updateUser(some.id, { email: '' }))?.email).toBeUndefined();
      // 주지 않으면 그대로 둔다
      const kept = await store.updateUser(none.id, { displayName: 'A2' });
      expect(kept?.email).toBeUndefined();
    });

    it('감사 기록 — 누가 바꿨는지 남는다(명시·문맥 둘 다)', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      // ① 명시로 준 경우
      await store.updateIdentifiable(
        packageId,
        'Submodel',
        target.id,
        { ...current.content, idShort: '명시' },
        { actor: { id: 'u-1', name: '홍길동' } },
      );
      // ② 요청 문맥으로 깐 경우 — 라우트가 매개변수를 넘기지 않아도 남아야 한다
      await runAsActor({ id: 'u-2', name: '김편집' }, async () => {
        await store.updateIdentifiable(packageId, 'Submodel', target.id, {
          ...current.content,
          idShort: '문맥',
        });
      });
      // ③ 명시가 문맥을 이긴다 — 저장소를 직접 쓰는 쪽이 설명할 수 없는 기록을 남기면 안 된다
      await runAsActor({ id: 'u-2', name: '김편집' }, async () => {
        await store.updateIdentifiable(
          packageId,
          'Submodel',
          target.id,
          { ...current.content, idShort: '명시우선' },
          { actor: { id: 'u-3', name: '배치작업' } },
        );
      });
      await runAsActor({ id: 'u-4', name: '박삭제' }, async () => {
        await store.deleteIdentifiable(packageId, 'Submodel', target.id);
      });

      const history = await store.history(packageId, 'Submodel', target.id);
      // 최신이 앞 — 지우기 · 명시우선 · 문맥 · 명시
      expect(history.map((h) => [h.operation, h.actorId, h.actorName])).toEqual([
        ['delete', 'u-4', '박삭제'],
        ['update', 'u-3', '배치작업'],
        ['update', 'u-2', '김편집'],
        ['update', 'u-1', '홍길동'],
      ]);
    });

    it('감사 기록 — 문맥은 요청끼리 섞이지 않는다', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      // 🔴 이것이 전역 변수 한 개가 아니라 AsyncLocalStorage여야 하는 이유다 —
      //    요청 둘이 겹쳐 돌 때 서로의 「누가」를 보면 감사 기록이 거짓이 된다
      const first = runAsActor({ id: 'a', name: '먼저' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await store.updateIdentifiable(packageId, 'Submodel', target.id, {
          ...current.content,
          idShort: '먼저고침',
        });
      });
      const second = runAsActor({ id: 'b', name: '나중' }, async () => {
        await store.updateIdentifiable(packageId, 'Submodel', target.id, {
          ...current.content,
          idShort: '나중고침',
        });
      });
      await Promise.all([first, second]);

      const history = await store.history(packageId, 'Submodel', target.id);
      const actors = history.map((h) => h.actorName).sort();
      expect(actors).toEqual(['나중', '먼저']);
    });

    it('낙관적 잠금 — 리비전이 어긋나면 거부한다', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      await expect(
        store.updateIdentifiable(packageId, 'Submodel', target.id, current.content, {
          expectedRevision: current.revision + 1,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('경로와 본문의 id가 다르면 거부한다', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      await expect(
        store.updateIdentifiable(packageId, 'Submodel', target.id, {
          ...current.content,
          id: 'https://www.smart-factory.kr/ids/sm/다른것/1/0',
        }),
      ).rejects.toBeInstanceOf(InvalidContentError);
    });

    it('없는 것을 찾으면 NotFoundError', async () => {
      const { store, packageId } = await seeded();
      await expect(store.getEnvironment('없는패키지')).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        store.updateIdentifiable(packageId, 'Submodel', '없는id', {
          modelType: 'Submodel',
          id: '없는id',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('결함 있는 파일도 손실 없이 받는다 — id 중복(KOSMO-CD-5)이 그대로 보존된다', async () => {
      const store = await create();
      await store.init();
      const damaged = readAasx(new Uint8Array(readFileSync(root + GOLDEN)));
      const duplicate = JSON.parse(JSON.stringify(damaged.environment.conceptDescriptions![0]!));
      damaged.environment.conceptDescriptions!.push(duplicate);

      const record = await store.importPackage({ name: '결함본', package: damaged });
      const env = await store.getEnvironment(record.id);
      expect(env.conceptDescriptions).toHaveLength(
        damaged.environment.conceptDescriptions!.length,
      );
      // 저장소는 통과시키고, 지적은 린터가 한다
      const result = lint(env, ALL_RULES);
      expect(result.countByRule['KOSMO-CD-5']).toBeGreaterThan(0);
    });

    it('🔴 번들 첨부(role bundle)는 보관만 하고 AASX로 내보내지 않는다 — 공정 파일 해시를 지킨다', async () => {
      const { store, packageId } = await seeded();
      const before = await store.exportPackage(packageId);
      await store.putPackageFile(packageId, {
        part: '/bundle/01_UseCase문서/RB01_UseCase.docx',
        role: 'bundle',
        contentType: 'application/octet-stream',
        data: new Uint8Array([9, 8, 7]),
      });
      const kept = (await store.packageFiles(packageId)).find((f) => f.role === 'bundle');
      expect(kept?.part).toBe('/bundle/01_UseCase문서/RB01_UseCase.docx');
      expect(kept?.data).toEqual(new Uint8Array([9, 8, 7]));

      const after = await store.exportPackage(packageId);
      expect([...after.extraParts.keys()].sort()).toEqual([...before.extraParts.keys()].sort());
      expect(after.supplementaryFiles.map((f) => f.part).sort()).toEqual(
        before.supplementaryFiles.map((f) => f.part).sort(),
      );
    });

    it('담을 때 함께 보관할 파일(keep) — 리비전은 1 그대로, AASX로는 안 나간다', async () => {
      const store = await create();
      await store.init();
      const record = await store.importPackage({
        name: GOLDEN,
        package: golden,
        keep: [{ part: '/.original/source.aasx', role: 'bundle', contentType: 'application/octet-stream', data: new Uint8Array([1, 2]) }],
      });
      expect(record.revision).toBe(1);
      expect((await store.getPackage(record.id))?.revision).toBe(1);
      expect((await store.packageFiles(record.id)).find((f) => f.part === '/.original/source.aasx')?.data).toEqual(new Uint8Array([1, 2]));
      const exported = await store.exportPackage(record.id);
      expect([...exported.extraParts.keys()]).not.toContain('/.original/source.aasx');
    });

    it('파트 단위로 읽고 쓰고 지운다 — 썸네일 교체가 이 경로로 간다', async () => {
      const { store, packageId } = await seeded();

      const files = await store.packageFiles(packageId);
      expect(files.some((f) => f.role === 'thumbnail')).toBe(true);

      const replacement = new Uint8Array([1, 2, 3, 4]);
      await store.putPackageFile(packageId, {
        part: '/thumbnail.png',
        role: 'thumbnail',
        contentType: 'image/png',
        data: replacement,
      });
      const after = await store.packageFiles(packageId);
      const thumbnail = after.find((f) => f.part === '/thumbnail.png')!;
      expect(thumbnail.data).toEqual(replacement);
      // 통째로 다시 써도 파트 수는 그대로다(덮어쓰기)
      expect(after).toHaveLength(files.length);

      // 내보내면 바뀐 것이 그대로 나온다
      const exported = await store.exportPackage(packageId);
      expect(exported.thumbnail?.data).toEqual(replacement);

      await store.deletePackageFile(packageId, '/thumbnail.png');
      expect((await store.packageFiles(packageId)).some((f) => f.part === '/thumbnail.png')).toBe(
        false,
      );
      await expect(store.deletePackageFile(packageId, '/없는파트')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('수집값은 쌓이되 모델을 건드리지 않는다 (A안)', async () => {
      const { store, packageId } = await seeded();
      const before = await store.getEnvironment(packageId);
      const beforeRevision = (await store.getPackage(packageId))!.revision;

      await store.appendValues(packageId, [
        {
          packageId,
          interfaceName: 'InterfaceTemplateForOPCUA',
          propertyName: 'MotorSpeed',
          source: 'ns=2;s=Machine.MotorSpeed',
          observedAt: '2026-08-24T00:00:00.000Z',
          valueNumber: 1200,
          quality: 'Good',
        },
        {
          packageId,
          interfaceName: 'InterfaceTemplateForOPCUA',
          propertyName: 'MotorSpeed',
          observedAt: '2026-08-24T00:00:01.000Z',
          valueNumber: 1210,
        },
        {
          packageId,
          interfaceName: 'InterfaceTemplateForOPCUA',
          propertyName: 'AlarmActive',
          observedAt: '2026-08-24T00:00:02.000Z',
          valueText: 'false',
          valueNumber: 0,
        },
      ]);

      // 🔴 모델은 그대로다 — 수집값이 모델로 되돌아가면 Type/Template 의미가 깨진다
      expect(canonicalJson(await store.getEnvironment(packageId))).toBe(canonicalJson(before));
      // 편집이 아니므로 리비전도 오르지 않는다
      expect((await store.getPackage(packageId))!.revision).toBe(beforeRevision);

      const all = await store.readValues(packageId);
      expect(all).toHaveLength(3);
      // 최근 것이 앞
      expect(all[0]!.propertyName).toBe('AlarmActive');

      const speed = await store.readValues(packageId, { propertyName: 'MotorSpeed' });
      expect(speed.map((v) => v.valueNumber)).toEqual([1210, 1200]);
      expect(speed[1]!.quality).toBe('Good');
      expect(speed[1]!.source).toBe('ns=2;s=Machine.MotorSpeed');

      const window = await store.readValues(packageId, {
        from: '2026-08-24T00:00:01.000Z',
        to: '2026-08-24T00:00:02.000Z',
      });
      expect(window).toHaveLength(1);
      expect(window[0]!.valueNumber).toBe(1210);

      expect(await store.readValues(packageId, { limit: 1 })).toHaveLength(1);
    });

    it('보존 기간 — 기준 시각보다 오래된 수집값만 모든 패키지에서 지운다', async () => {
      const { store, packageId } = await seeded();
      const other = (await store.importPackage({ name: 'other.aasx', package: golden })).id;
      const sample = (observedAt: string, valueNumber: number) => ({
        packageId,
        interfaceName: 'I',
        propertyName: 'P',
        observedAt,
        valueNumber,
      });
      await store.appendValues(packageId, [
        sample('2026-01-01T00:00:00.000Z', 1),
        sample('2026-06-01T00:00:00.000Z', 2),
        sample('2026-09-01T00:00:00.000Z', 3),
      ]);
      await store.appendValues(other, [
        { ...sample('2026-01-02T00:00:00.000Z', 4), packageId: other },
      ]);

      expect(await store.pruneValues('2026-06-01T00:00:00.000Z')).toBe(2);
      // 기준 시각과 같은 것은 남는다(observedAt >= before)
      expect((await store.readValues(packageId)).map((v) => v.valueNumber)).toEqual([3, 2]);
      expect(await store.readValues(other)).toHaveLength(0);
      // 모델·리비전은 그대로
      expect((await store.getPackage(packageId))!.revision).toBe(1);
      // 지울 것이 없으면 0
      expect(await store.pruneValues('2020-01-01T00:00:00.000Z')).toBe(0);
    });

    it('패키지를 지우면 수집값도 함께 사라진다', async () => {
      const { store, packageId } = await seeded();
      await store.appendValues(packageId, [
        {
          packageId,
          interfaceName: 'I',
          propertyName: 'P',
          observedAt: '2026-08-24T00:00:00.000Z',
          valueNumber: 1,
        },
      ]);
      await store.deletePackage(packageId);
      await expect(store.readValues(packageId)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('패키지를 지우면 소속 Identifiable도 함께 사라진다', async () => {
      const { store, packageId } = await seeded();
      await store.deletePackage(packageId);
      expect(await store.getPackage(packageId)).toBeUndefined();
      await expect(store.getEnvironment(packageId)).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── 사용자 (2026-10-02) ─────────────────────────────────────────────────
    describe('사용자', () => {
      it('계정이 없으면 0 — 첫 관리자 만들기를 띄울 근거다', async () => {
        const store = await create();
        await store.init(); // 🔴 표가 있어야 한다 — PGlite는 init 전엔 빈 DB다
        expect(await store.countUsers()).toBe(0);
        expect(await store.listUsers()).toEqual([]);
      });

      it('만들고 로그인 이름으로 찾는다', async () => {
        const store = await create();
        await store.init(); // 🔴 표가 있어야 한다 — PGlite는 init 전엔 빈 DB다
        const made = await store.createUser({
          login: 'kim',
          displayName: '김기사',
          role: 'editor',
          passwordHash: 'hash1',
        });
        expect(made.role).toBe('editor');
        expect(made.disabled).toBe(false);
        expect(made.lastLoginAt).toBeUndefined();

        const found = await store.findUserByLogin('kim');
        expect(found?.id).toBe(made.id);
        expect(await store.countUsers()).toBe(1);
        expect((await store.getUser(made.id))?.displayName).toBe('김기사');
      });

      it('🔴 로그인 이름은 대소문자를 가리지 않는다 — Kim과 kim은 같은 사람이다', async () => {
        const store = await create();
        await store.init(); // 🔴 표가 있어야 한다 — PGlite는 init 전엔 빈 DB다
        await store.createUser({ login: 'Kim', displayName: 'K', role: 'admin', passwordHash: 'h' });
        expect((await store.findUserByLogin('kim'))?.login).toBe('kim');
        expect((await store.findUserByLogin('KIM'))?.login).toBe('kim');
        await expect(
          store.createUser({ login: 'kIm', displayName: '다른 사람', role: 'viewer', passwordHash: 'h2' }),
        ).rejects.toThrow();
        expect(await store.countUsers()).toBe(1);
      });

      it('이름이 비면 로그인 이름을 그대로 쓴다', async () => {
        const store = await create();
        await store.init(); // 🔴 표가 있어야 한다 — PGlite는 init 전엔 빈 DB다
        const made = await store.createUser({ login: 'lee', displayName: '  ', role: 'viewer', passwordHash: 'h' });
        expect(made.displayName).toBe('lee');
      });

      it('🔴 고칠 때 준 것만 바뀐다 — 안 준 값이 지워지면 안 된다', async () => {
        const store = await create();
        await store.init(); // 🔴 표가 있어야 한다 — PGlite는 init 전엔 빈 DB다
        const made = await store.createUser({
          login: 'park', displayName: '박', role: 'viewer', passwordHash: 'old',
        });
        const after = await store.updateUser(made.id, { role: 'editor' });
        expect(after?.role).toBe('editor');
        expect(after?.displayName).toBe('박');       // 그대로
        expect(after?.passwordHash).toBe('old');     // 그대로
        expect(after?.disabled).toBe(false);         // 그대로

        const locked = await store.updateUser(made.id, { disabled: true });
        expect(locked?.disabled).toBe(true);
        expect(locked?.role).toBe('editor');
      });

      it('없는 사람을 고치면 undefined', async () => {
        const store = await create();
        await store.init(); // 🔴 표가 있어야 한다 — PGlite는 init 전엔 빈 DB다
        expect(await store.updateUser('user_없음', { role: 'admin' })).toBeUndefined();
        expect(await store.getUser('user_없음')).toBeUndefined();
      });

      it('로그인 시각이 찍힌다', async () => {
        const store = await create();
        await store.init(); // 🔴 표가 있어야 한다 — PGlite는 init 전엔 빈 DB다
        const made = await store.createUser({ login: 'choi', displayName: '최', role: 'admin', passwordHash: 'h' });
        await store.touchUserLogin(made.id);
        expect((await store.getUser(made.id))?.lastLoginAt).toBeTruthy();
      });
    });
  });
}

/** 필터는 두 구현이 같아야 한다 — Part 2의 idShort·semanticId 질의 인자가 여기 얹힌다 */
export function describeStoreFilters(name: string, create: () => Promise<AasStore>): void {
  describe(`${name} — 목록 필터`, () => {
    it('idShort · semanticId · assetKind로 거른다', async () => {
      const golden = loadGolden();
      const store = await create();
      await store.init();
      const record = await store.importPackage({ name: GOLDEN, package: golden });

      const byIdShort = await store.listIdentifiables(record.id, 'Submodel', {
        idShort: 'TechnicalData',
      });
      expect(byIdShort.items.map((r) => r.idShort)).toEqual(['TechnicalData']);

      const semantic = golden.environment.submodels![0]!.semanticId!.keys[0]!.value;
      const bySemantic = await store.listIdentifiables(record.id, 'Submodel', {
        semanticId: semantic,
      });
      expect(bySemantic.items.map((r) => r.idShort)).toEqual(['DigitalNameplate']);

      const byKind = await store.listIdentifiables(record.id, 'AssetAdministrationShell', {
        assetKind: 'Type',
      });
      expect(byKind.items).toHaveLength(1);
      const none = await store.listIdentifiables(record.id, 'AssetAdministrationShell', {
        assetKind: 'Instance',
      });
      expect(none.items).toHaveLength(0);
    });
  });
}
