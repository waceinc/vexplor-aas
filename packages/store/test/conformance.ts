/**
 * Store conformance tests — run the **same scenarios** against InMemoryStore and PostgresStore.
 *
 * Having two implementations is itself the risk (development runs in memory, production on Postgres).
 * A single shared suite makes any divergence fail immediately.
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
import { describeStoreIntegration } from './conformance-integration.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-roll-forming-machine.aasx';

function loadGolden(): ReturnType<typeof readAasx> {
  return readAasx(new Uint8Array(readFileSync(root + GOLDEN)));
}

/** Full scenario set for one implementation */
export function describeStore(name: string, create: () => Promise<AasStore>): void {
  describe(`${name} — store conformance`, () => {
    let golden: ReturnType<typeof readAasx>;
    beforeAll(() => {
      golden = loadGolden();
    });

    /** Creates a fresh store seeded with the golden file */
    async function seeded(): Promise<{ store: AasStore; packageId: string }> {
      const store = await create();
      await store.init();
      const record = await store.importPackage({ name: GOLDEN, package: golden });
      return { store, packageId: record.id };
    }

    it('lossless round trip — after import → export the Environment is semantically equal to the original', async () => {
      const { store, packageId } = await seeded();
      const exported = await store.exportPackage(packageId);
      expect(canonicalJson(exported.environment)).toBe(canonicalJson(golden.environment));
      expect(exported.specPart).toBe(golden.specPart);
    });

    it('lossless round trip — thumbnail, attachments and other parts survive intact', async () => {
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

    it('Phase 2 acceptance — re-saving through the store yields 0 violations', async () => {
      const { store, packageId } = await seeded();
      const exported = await store.exportPackage(packageId);
      const reread = readAasx(writeAasx(exported));
      const result = lint(reread.environment, ALL_RULES, { package: reread.opc });
      expect(result.countBySeverity.error).toBe(0);
      expect(canonicalJson(reread.environment)).toBe(canonicalJson(golden.environment));
    });

    it('Identifiable lists preserve the original array order', async () => {
      const { store, packageId } = await seeded();
      const submodels = await store.listIdentifiables(packageId, 'Submodel');
      expect(submodels.items.map((r) => r.idShort)).toEqual(
        golden.environment.submodels!.map((s) => s.idShort),
      );
    });

    it('derives lookup columns (idShort · kind · semanticId · assetKind)', async () => {
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

    it('pagination — following the cursor yields every item exactly once', async () => {
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

    it('can insert at a given position — placing a new item in a deleted slot preserves order (2026-09-07)', async () => {
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
      // Without a position it still goes to the end
      const tail = await store.createIdentifiable(packageId, { ...first.content, id: `${first.id}-tail` });
      expect(tail.ordinal).toBeGreaterThan(Math.max(...after.items.map((r) => r.ordinal)));
    });

    it('CRUD — create, update, delete', async () => {
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
      // Not only the derived columns but the source JSON changes too
      expect((updated.content as { idShort: string }).idShort).toBe('ExtraRenamed');

      await store.deleteIdentifiable(packageId, 'Submodel', created.id);
      expect(await store.getIdentifiable(packageId, 'Submodel', created.id)).toBeUndefined();
    });

    it('version history — prior content is kept, newest first', async () => {
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
      // A change without a "who" stays **empty** — never invent facts that do not exist
      expect(history[0]!.actorId).toBeUndefined();
      expect(history[0]!.actorName).toBeUndefined();
    });

    it('package owner — omitted means shared; a given owner comes back unchanged', async () => {
      const { store, packageId } = await seeded();
      // Important: with no owner the key is absent altogether — do not conflate "shared" with "empty owner"
      expect((await store.getPackage(packageId))?.owner).toBeUndefined();

      const mine = await store.importPackage({ name: '내것.aasx', package: golden, owner: 'user:a' });
      expect(mine.owner).toBe('user:a');
      expect((await store.getPackage(mine.id))?.owner).toBe('user:a');
      // null means "deliberately shared" — used to keep a shared file shared when replacing it wholesale
      const shared = await store.importPackage({ name: '공용.aasx', package: golden, owner: null });
      expect(shared.owner).toBeUndefined();
    });

    it('filters the list by owner — only mine and shared, never others', async () => {
      const { store, packageId } = await seeded(); // one shared
      const a = await store.importPackage({ name: 'a.aasx', package: golden, owner: 'user:a' });
      const b = await store.importPackage({ name: 'b.aasx', package: golden, owner: 'user:b' });

      const seenByA = (await store.listPackages({}, { owner: 'user:a' })).items.map((item) => item.id);
      expect(seenByA).toContain(a.id);
      expect(seenByA).toContain(packageId);
      expect(seenByA).not.toContain(b.id);

      // Without a scope, everything — this is how the server itself (collection, cleanup) sees it
      expect((await store.listPackages()).items).toHaveLength(3);
    });

    it('paginates after filtering — filtering outside leaves pages short and gets the has-next-page flag wrong', async () => {
      const { store } = await seeded(); // 1 shared
      // Alternate others' and mine so they interleave in id order
      const mine: string[] = [];
      for (let n = 0; n < 4; n += 1) {
        await store.importPackage({ name: `남${n}.aasx`, package: golden, owner: 'user:b' });
        mine.push((await store.importPackage({ name: `내${n}.aasx`, package: golden, owner: 'user:a' })).id);
      }
      // 4 mine + 1 shared = 5 items, fetched 2 at a time
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.listPackages(cursor === undefined ? { limit: 2 } : { limit: 2, cursor }, { owner: 'user:a' });
        // Every page but the last must be **full**
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

    it('deletes an account (withdrawal) — deleting a missing one returns false', async () => {
      const { store } = await seeded();
      const made = await store.createUser({
        login: 'hong', displayName: '홍길동', role: 'editor', passwordHash: 'h',
      });
      expect(await store.deleteUser(made.id)).toBe(true);
      expect(await store.getUser(made.id)).toBeUndefined();
      expect(await store.findUserByLogin('hong')).toBeUndefined();
      // Re-registering with the same login must work — the slot is free after deletion
      expect((await store.createUser({
        login: 'hong', displayName: '다른 사람', role: 'viewer', passwordHash: 'h',
      })).login).toBe('hong');
      expect(await store.deleteUser('user_없음')).toBe(false);
    });

    it('deleting an account keeps the history that user left — audit records must not vanish retroactively', async () => {
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

    it('contact info is optional — absent when omitted, cleared by an empty string', async () => {
      const { store } = await seeded();
      const none = await store.createUser({
        login: 'a', displayName: 'A', role: 'editor', passwordHash: 'h',
      });
      // Important: do not conflate "not provided" with "provided as empty"
      expect(none.email).toBeUndefined();

      const some = await store.createUser({
        login: 'b', displayName: 'B', role: 'editor', passwordHash: 'h', email: ' b@example.com ',
      });
      expect(some.email).toBe('b@example.com');
      expect((await store.findUserByLogin('b'))?.email).toBe('b@example.com');

      // An empty string means "clear it" — used for requests to remove personal data
      expect((await store.updateUser(some.id, { email: '' }))?.email).toBeUndefined();
      // Company name can also be changed and cleared (2026-10-08 account settings) — only given fields change
      expect((await store.updateUser(some.id, { company: ' 와이스 ' }))?.company).toBe('와이스');
      expect((await store.updateUser(some.id, { displayName: 'B2' }))?.company).toBe('와이스');
      expect((await store.updateUser(some.id, { company: '' }))?.company).toBeUndefined();

      // Revision 7 — company name and consent timestamp
      const at = '2026-10-06T07:00:00.000Z';
      const member = await store.createUser({
        login: 'c', displayName: '김철수', role: 'editor', passwordHash: 'h', email: 'c@example.com', company: ' WACE ', consentAt: at,
      });
      expect(member.company).toBe('WACE');
      expect(member.consentAt).toBe(at);
      expect((await store.getUser(member.id))?.company).toBe('WACE');
      expect((await store.getUser(member.id))?.consentAt).toBe(at);
      expect(none.company).toBeUndefined();
      // Fields not given are left as is
      const kept = await store.updateUser(none.id, { displayName: 'A2' });
      expect(kept?.email).toBeUndefined();
    });

    it('audit trail — records who made the change (both explicit and contextual)', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      // (1) Given explicitly
      await store.updateIdentifiable(
        packageId,
        'Submodel',
        target.id,
        { ...current.content, idShort: '명시' },
        { actor: { id: 'u-1', name: '홍길동' } },
      );
      // (2) Set via request context — must be recorded even if the route passes no parameter
      await runAsActor({ id: 'u-2', name: '김편집' }, async () => {
        await store.updateIdentifiable(packageId, 'Submodel', target.id, {
          ...current.content,
          idShort: '문맥',
        });
      });
      // (3) Explicit beats context — direct store callers must not leave records they cannot explain
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
      // Newest first — delete · explicit-over-context · context · explicit
      expect(history.map((h) => [h.operation, h.actorId, h.actorName])).toEqual([
        ['delete', 'u-4', '박삭제'],
        ['update', 'u-3', '배치작업'],
        ['update', 'u-2', '김편집'],
        ['update', 'u-1', '홍길동'],
      ]);
    });

    it('audit trail — context does not leak between requests', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      // Important: this is why it must be AsyncLocalStorage rather than a single global —
      //    if two overlapping requests saw each other's "who", the audit trail would lie
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

    it('optimistic locking — rejects on revision mismatch', async () => {
      const { store, packageId } = await seeded();
      const target = golden.environment.submodels![0]!;
      const current = (await store.getIdentifiable(packageId, 'Submodel', target.id))!;

      await expect(
        store.updateIdentifiable(packageId, 'Submodel', target.id, current.content, {
          expectedRevision: current.revision + 1,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects when the path id and body id differ', async () => {
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

    it('looking up something missing throws NotFoundError', async () => {
      const { store, packageId } = await seeded();
      await expect(store.getEnvironment('없는패키지')).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        store.updateIdentifiable(packageId, 'Submodel', '없는id', {
          modelType: 'Submodel',
          id: '없는id',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('accepts defective files losslessly — duplicate ids (KOSMO-CD-5) are preserved as is', async () => {
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
      // The store lets it through; the linter reports it
      const result = lint(env, ALL_RULES);
      expect(result.countByRule['KOSMO-CD-5']).toBeGreaterThan(0);
    });

    it('bundle attachments (role bundle) are stored but not exported to AASX — preserves the process file hash', async () => {
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

    it('files kept alongside on import (keep) — revision stays 1 and they are not exported to AASX', async () => {
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

    it('reads, writes and deletes per part — thumbnail replacement goes through this path', async () => {
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
      // Rewriting wholesale keeps the part count (overwrite)
      expect(after).toHaveLength(files.length);

      // Export reflects the change
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

    it('collected values accumulate without touching the model (option A)', async () => {
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

      // Important: the model is unchanged — writing collected values back into it would break Type/Template semantics
      expect(canonicalJson(await store.getEnvironment(packageId))).toBe(canonicalJson(before));
      // Not an edit, so the revision does not increase
      expect((await store.getPackage(packageId))!.revision).toBe(beforeRevision);

      const all = await store.readValues(packageId);
      expect(all).toHaveLength(3);
      // Most recent first
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

    it('a value with a key is stored once — a batch sent again adds nothing (remote collector, plan gap 8)', async () => {
      const { store, packageId } = await seeded();
      const value = (seq: number, index: number, valueNumber: number) => ({
        packageId,
        interfaceName: 'InterfaceOPCUA',
        propertyName: 'MotorSpeed',
        observedAt: `2026-08-24T00:00:0${index}.000Z`,
        valueNumber,
        key: `edge:dev_1:boot:${seq}:${index}`,
      });
      await store.appendValues(packageId, [value(1, 0, 10), value(1, 1, 11)]);
      // The same batch again (the answer was lost), and one new value in a mixed batch
      await store.appendValues(packageId, [value(1, 0, 10), value(1, 1, 11), value(2, 2, 12)]);
      // Values without a key are never deduplicated — the server's own collector keeps working as before
      const plain = { packageId, interfaceName: 'InterfaceOPCUA', propertyName: 'MotorSpeed', observedAt: '2026-08-24T00:00:05.000Z', valueNumber: 1 };
      await store.appendValues(packageId, [plain, plain]);
      const all = await store.readValues(packageId);
      expect(all.map((v) => v.valueNumber).sort()).toEqual([1, 1, 10, 11, 12]);
      // The key is bookkeeping, not part of what is read back
      expect(all.every((v) => !('key' in v))).toBe(true);
    });

    it('receivedAt is stored separately from the device time — absent stays absent (legacy records)', async () => {
      const { store, packageId } = await seeded();
      await store.appendValues(packageId, [
        {
          packageId,
          interfaceName: 'InterfaceTemplateForOPCUA',
          propertyName: 'Constant',
          // Important: a constant-value tag — its device time froze long ago, but it was just read
          observedAt: '2026-01-01T00:00:00.000Z',
          receivedAt: '2026-10-13T09:00:00.000Z',
          valueNumber: 7,
        },
        {
          packageId,
          interfaceName: 'InterfaceTemplateForOPCUA',
          propertyName: 'Old',
          observedAt: '2026-01-01T00:00:01.000Z',
          valueNumber: 1,
        },
      ]);
      const constant = await store.readValues(packageId, { propertyName: 'Constant' });
      expect(constant[0]!.receivedAt).toBe('2026-10-13T09:00:00.000Z');
      expect(constant[0]!.observedAt).toBe('2026-01-01T00:00:00.000Z');
      const old = await store.readValues(packageId, { propertyName: 'Old' });
      expect(old[0]!.receivedAt).toBeUndefined();
    });

    it('time ranges can use receivedAt — constant-value tags are caught by values received that day', async () => {
      const { store, packageId } = await seeded();
      const base = { packageId, interfaceName: 'I', propertyName: 'State', valueText: 'run' };
      await store.appendValues(packageId, [
        // Device time is frozen at yesterday; received twice today
        { ...base, observedAt: '2026-10-12T23:00:00.000Z', receivedAt: '2026-10-13T08:10:00.000Z' },
        { ...base, observedAt: '2026-10-12T23:00:00.000Z', receivedAt: '2026-10-13T08:20:00.000Z' },
        // Legacy record (no receivedAt) — falls back to device time
        { ...base, observedAt: '2026-10-13T08:15:00.000Z' },
        { ...base, observedAt: '2026-10-12T22:00:00.000Z', receivedAt: '2026-10-12T22:00:01.000Z' },
      ]);
      const day = { propertyName: 'State', from: '2026-10-13T08:00:00.000Z', to: '2026-10-14T08:00:00.000Z' };
      expect(await store.readValues(packageId, day)).toHaveLength(1); // Default (device time) matches only the legacy record
      const received = await store.readValues(packageId, { ...day, basis: 'received' });
      expect(received.map((v) => v.receivedAt ?? v.observedAt)).toEqual([
        '2026-10-13T08:20:00.000Z',
        '2026-10-13T08:15:00.000Z',
        '2026-10-13T08:10:00.000Z',
      ]);
    });

    it('retention prunes by receivedAt — freshly received values of tags with long-frozen device time survive', async () => {
      const { store, packageId } = await seeded();
      await store.appendValues(packageId, [
        { packageId, interfaceName: 'I', propertyName: 'Constant', observedAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-10-13T09:00:00.000Z', valueNumber: 7 },
        { packageId, interfaceName: 'I', propertyName: 'Constant', observedAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:05.000Z', valueNumber: 7 },
      ]);
      expect(await store.pruneValues('2026-06-01T00:00:00.000Z')).toBe(1);
      expect((await store.readValues(packageId)).map((v) => v.receivedAt)).toEqual(['2026-10-13T09:00:00.000Z']);
    });

    it('retention — prunes only values older than the cutoff, across all packages', async () => {
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
      // Values equal to the cutoff are kept (observedAt >= before)
      expect((await store.readValues(packageId)).map((v) => v.valueNumber)).toEqual([3, 2]);
      expect(await store.readValues(other)).toHaveLength(0);
      // Model and revision unchanged
      expect((await store.getPackage(packageId))!.revision).toBe(1);
      // 0 when nothing to prune
      expect(await store.pruneValues('2020-01-01T00:00:00.000Z')).toBe(0);
    });

    it('deleting a package also removes its collected values', async () => {
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

    it('deleting a package also removes its Identifiables', async () => {
      const { store, packageId } = await seeded();
      await store.deletePackage(packageId);
      expect(await store.getPackage(packageId)).toBeUndefined();
      await expect(store.getEnvironment(packageId)).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── Users (2026-10-02) ──────────────────────────────────────────────────
    describe('users', () => {
      it('0 when there are no accounts — the basis for showing first-admin setup', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
        expect(await store.countUsers()).toBe(0);
        expect(await store.listUsers()).toEqual([]);
      });

      it('creates and finds by login name', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
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

      it('login names are case-insensitive — Kim and kim are the same person', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
        await store.createUser({ login: 'Kim', displayName: 'K', role: 'admin', passwordHash: 'h' });
        expect((await store.findUserByLogin('kim'))?.login).toBe('kim');
        expect((await store.findUserByLogin('KIM'))?.login).toBe('kim');
        await expect(
          store.createUser({ login: 'kIm', displayName: '다른 사람', role: 'viewer', passwordHash: 'h2' }),
        ).rejects.toThrow();
        expect(await store.countUsers()).toBe(1);
      });

      it('falls back to the login name when the display name is blank', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
        const made = await store.createUser({ login: 'lee', displayName: '  ', role: 'viewer', passwordHash: 'h' });
        expect(made.displayName).toBe('lee');
      });

      it('updates change only given fields — omitted values must not be cleared', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
        const made = await store.createUser({
          login: 'park', displayName: '박', role: 'viewer', passwordHash: 'old',
        });
        const after = await store.updateUser(made.id, { role: 'editor' });
        expect(after?.role).toBe('editor');
        expect(after?.displayName).toBe('박');       // unchanged
        expect(after?.passwordHash).toBe('old');     // unchanged
        expect(after?.disabled).toBe(false);         // unchanged

        const locked = await store.updateUser(made.id, { disabled: true });
        expect(locked?.disabled).toBe(true);
        expect(locked?.role).toBe('editor');
      });

      it('updating a missing user returns undefined', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
        expect(await store.updateUser('user_없음', { role: 'admin' })).toBeUndefined();
        expect(await store.getUser('user_없음')).toBeUndefined();
      });

      it('creates the first account only while there is none, even when two calls race (red-team L3)', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
        const results = await Promise.all([
          store.createFirstUser({ login: 'first1', displayName: 'A', role: 'admin', passwordHash: 'h1' }),
          store.createFirstUser({ login: 'first2', displayName: 'B', role: 'admin', passwordHash: 'h2' }),
        ]);
        expect(results.filter((made) => made !== undefined)).toHaveLength(1);
        expect(await store.countUsers()).toBe(1);
        // Once an account exists it never creates another
        expect(await store.createFirstUser({ login: 'late', displayName: 'C', role: 'admin', passwordHash: 'h3' })).toBeUndefined();
        expect(await store.countUsers()).toBe(1);
      });

      it('records the login time', async () => {
        const store = await create();
        await store.init(); // Important: tables must exist — PGlite is an empty DB before init
        const made = await store.createUser({ login: 'choi', displayName: '최', role: 'admin', passwordHash: 'h' });
        await store.touchUserLogin(made.id);
        expect((await store.getUser(made.id))?.lastLoginAt).toBeTruthy();
      });
    });
  });

  // Integration part of the port (events, subscriptions, deliveries, configs, refs, state) — same stores, same rules
  describeStoreIntegration(name, create);
}

/** Filters must match across both implementations — Part 2's idShort/semanticId query params build on this */
export function describeStoreFilters(name: string, create: () => Promise<AasStore>): void {
  describe(`${name} — list filters`, () => {
    it('filters by idShort · semanticId · assetKind', async () => {
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
