/**
 * M2 검수 기준 — 기획서 Phase 2:
 *   "기존 롤포밍기 AASX를 불러온 뒤 다시 저장했을 때 Validator 오류 0건"
 *
 * 그 전제가 되는 무손실 왕복을 여기서 검증한다.
 * 특히 린터 명세 §6-1의 실측 결함(basyx가 서브모델을 7→5로 조용히 드롭)을
 * 우리 구현이 재발시키지 않는지 개수로 확인한다.
 */
import { canonicalJson, collectElements, type Environment } from '@aas/core';
import { readAasx, writeAasx, parseContentTypes, parseRelationships, REL_TYPE } from '@aas/aasx';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FIXTURES, GOLDEN, loadFixture } from './fixtures.js';

/** 원본 ZIP에서 data.json을 직접 꺼낸다 — 우리 리더를 거치지 않은 기준값 */
function rawEnvironment(buffer: Uint8Array): Environment {
  const entries = unzipSync(buffer);
  const raw = entries['aasx/data.json'];
  if (!raw) throw new Error('aasx/data.json이 없습니다.');
  return JSON.parse(strFromU8(raw)) as Environment;
}

describe('AASX 읽기', () => {
  it('골든 파일의 서브모델·CD를 하나도 잃지 않는다', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    expect(pkg.environment.assetAdministrationShells).toHaveLength(1);
    expect(pkg.environment.submodels).toHaveLength(7); // basyx는 여기서 5로 떨어뜨린다
    expect(pkg.environment.conceptDescriptions).toHaveLength(137);
    expect(pkg.warnings).toEqual([]);
  });

  it('SML 서브트리를 포함한 모든 요소를 순회할 수 있다', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    const elements = collectElements(pkg.environment);
    const byType = new Map<string, number>();
    for (const e of elements) byType.set(e.node.modelType, (byType.get(e.node.modelType) ?? 0) + 1);

    // 실측 분포 (aasx/data.json 직접 파싱 기준)
    expect(byType.get('Property')).toBe(84);
    expect(byType.get('SubmodelElementCollection')).toBe(45);
    expect(byType.get('MultiLanguageProperty')).toBe(21);
    expect(byType.get('SubmodelElementList')).toBe(9);
    expect(byType.get('Entity')).toBe(6);
    expect(byType.get('RelationshipElement')).toBe(5);
    expect(byType.get('ReferenceElement')).toBe(3);
    expect(byType.get('File')).toBe(2);
  });

  it('썸네일 파트를 관계로부터 찾아낸다', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    expect(pkg.thumbnail).toBeDefined();
    expect(pkg.thumbnail?.part).toBe('/thumbnail.png');
    expect(pkg.thumbnail?.contentType).toBe('image/png');
    expect(pkg.thumbnail?.data.byteLength).toBeGreaterThan(0);
  });

  it('KOSMO 리포트와 같은 형식의 경로를 만든다', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    const elements = collectElements(pkg.environment);
    const first = elements[0];
    expect(first).toBeDefined();
    expect(first?.pointer).toMatch(/^\/submodels\/\d+\/submodelElements\/\d+/);
    // 예: /submodels/3(OperationalData)/submodelElements/0(...)
    expect(first?.kosmoPath).toMatch(/^\/submodels\/\d+\([^)]+\)\/submodelElements\/\d+/);
  });
});

describe('AASX 왕복 (read → write → read)', () => {
  for (const name of FIXTURES) {
    it(`${name} — Environment가 의미적으로 동일하다`, () => {
      const original = loadFixture(name);
      const pkg = readAasx(original);
      const rewritten = writeAasx(pkg);
      const reread = readAasx(rewritten);

      expect(canonicalJson(reread.environment)).toBe(canonicalJson(pkg.environment));
      expect(reread.warnings).toEqual([]);
    });

    it(`${name} — 원본 data.json과도 의미적으로 동일하다`, () => {
      const original = loadFixture(name);
      const reread = readAasx(writeAasx(readAasx(original)));
      expect(canonicalJson(reread.environment)).toBe(canonicalJson(rawEnvironment(original)));
    });

    it(`${name} — 썸네일과 첨부 파일이 바이트 단위로 보존된다`, () => {
      const pkg = readAasx(loadFixture(name));
      const reread = readAasx(writeAasx(pkg));

      expect(reread.thumbnail?.data).toEqual(pkg.thumbnail?.data);
      expect(reread.supplementaryFiles.map((f) => f.part))
        .toEqual(pkg.supplementaryFiles.map((f) => f.part));
      for (const [i, f] of reread.supplementaryFiles.entries()) {
        expect(f.data).toEqual(pkg.supplementaryFiles[i]?.data);
      }
    });
  }

  it('출력이 결정론적이다 (같은 입력 → 바이트 동일)', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    expect(writeAasx(pkg)).toEqual(writeAasx(pkg));
  });
});

describe('OPC 패키지 구조 (PKG-THUMB-PART)', () => {
  it('파트 · 관계 · Content_Types 세 곳이 모두 정합한다', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    const entries = unzipSync(writeAasx(pkg));
    const partNames = new Set(Object.keys(entries).map((n) => `/${n}`));

    // ① 필수 파트 존재
    for (const p of ['/[Content_Types].xml', '/_rels/.rels', '/aasx/aasx-origin', '/aasx/data.json']) {
      expect(partNames.has(p), `파트 누락: ${p}`).toBe(true);
    }

    // ② 관계 선언
    const rootRels = parseRelationships(strFromU8(entries['_rels/.rels']!), '/');
    expect(rootRels.find((r) => r.type === REL_TYPE.origin)?.target).toBe('/aasx/aasx-origin');
    expect(rootRels.find((r) => r.type === REL_TYPE.thumbnail)?.target).toBe('/thumbnail.png');

    const originRels = parseRelationships(strFromU8(entries['aasx/_rels/aasx-origin.rels']!), '/aasx');
    expect(originRels.find((r) => r.type === REL_TYPE.spec)?.target).toBe('/aasx/data.json');

    // ③ Content_Types Override — 선언된 파트가 실제로 존재해야 한다
    const ct = parseContentTypes(strFromU8(entries['[Content_Types].xml']!));
    expect(ct.overrides.get('/aasx/data.json')).toBe('application/json');
    expect(ct.overrides.get('/thumbnail.png')).toBe('image/png');
    for (const part of ct.overrides.keys()) {
      expect(partNames.has(part), `Override는 있으나 파트가 없음: ${part}`).toBe(true);
    }
    // 역방향 — 모든 파트가 Content_Types에 선언돼야 한다
    for (const part of partNames) {
      if (part === '/[Content_Types].xml') continue;
      expect(ct.overrides.has(part), `파트는 있으나 Override가 없음: ${part}`).toBe(true);
    }
  });
});
