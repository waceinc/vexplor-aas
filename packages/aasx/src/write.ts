/**
 * AASX 쓰기 — 기획서 M2.
 *
 * 파트 · 관계 · Content_Types 세 곳을 항상 함께 갱신한다(PKG-THUMB-PART).
 * 골든 파일(01-롤포밍기)과 동일한 관계 ID 규칙을 따른다: origin=r1, thumbnail=r3, spec=r0.
 */
import { serializeEnvironment } from '@aas/core';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  buildContentTypes,
  buildRelationships,
  guessContentType,
  RELS_CONTENT_TYPE,
  REL_TYPE,
  relsPathFor,
  toEntryName,
  type ContentTypes,
  type Relationship,
} from './opc.js';
import { ORIGIN_PART, type AasxPackage } from './package.js';

export interface WriteOptions {
  /** data.json 들여쓰기. 기본 2 */
  indent?: number;
  /**
   * ZIP 엔트리 수정시각(Unix epoch ms). 지정하면 출력이 결정론적이 된다.
   * 회귀 테스트와 CI 재현성을 위해 기본값을 고정해 둔다.
   */
  mtime?: number;
  /** 압축 레벨 0~9. 기본 6 */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/** 결정론적 출력을 위한 기본 타임스탬프 (2026-01-01T00:00:00Z) */
export const DETERMINISTIC_MTIME = 1767225600000;

export function writeAasx(pkg: AasxPackage, options: WriteOptions = {}): Uint8Array {
  const { indent = 2, mtime = DETERMINISTIC_MTIME, level = 6 } = options;

  const specPart = pkg.specPart;
  const parts = new Map<string, Uint8Array>();
  const contentTypes: ContentTypes = { defaults: new Map(), overrides: new Map() };

  const addPart = (part: string, data: Uint8Array, contentType: string): void => {
    parts.set(part, data);
    contentTypes.overrides.set(part, contentType);
  };

  // ① AAS 본문
  addPart(specPart, strToU8(serializeEnvironment(pkg.environment, { indent })), 'application/json');

  // ② origin 파트 (내용 없음 — 존재 자체가 AASX임을 표시한다)
  addPart(ORIGIN_PART, new Uint8Array(0), 'text/plain');

  // ③ 썸네일 · 첨부 파일
  const rootRels: Relationship[] = [
    { id: 'r1', type: REL_TYPE.origin, target: ORIGIN_PART, targetMode: 'Internal' },
  ];
  if (pkg.thumbnail) {
    const t = pkg.thumbnail;
    addPart(t.part, t.data, t.contentType || guessContentType(t.part));
    rootRels.push({ id: 'r3', type: REL_TYPE.thumbnail, target: t.part, targetMode: 'Internal' });
  }

  const specRels: Relationship[] = [];
  pkg.supplementaryFiles.forEach((f, i) => {
    addPart(f.part, f.data, f.contentType || guessContentType(f.part));
    specRels.push({
      id: `rs${i}`,
      type: REL_TYPE.suppl,
      target: f.part,
      targetMode: 'Internal',
    });
  });

  // ④ 보존 대상 기타 파트
  for (const [part, data] of pkg.extraParts) {
    if (parts.has(part)) continue;
    addPart(part, data, guessContentType(part));
  }

  // ⑤ 관계 파일 3종 — 파트를 다 채운 뒤에 만든다
  const originRelsPart = relsPathFor(ORIGIN_PART);
  const specRelsPart = relsPathFor(specPart);
  const originRels: Relationship[] = [
    { id: 'r0', type: REL_TYPE.spec, target: specPart, targetMode: 'Internal' },
  ];

  addPart('/_rels/.rels', strToU8(buildRelationships(rootRels)), RELS_CONTENT_TYPE);
  addPart(originRelsPart, strToU8(buildRelationships(originRels)), RELS_CONTENT_TYPE);
  addPart(specRelsPart, strToU8(buildRelationships(specRels)), RELS_CONTENT_TYPE);

  // ⑥ [Content_Types].xml — 자기 자신은 Override 대상이 아니다
  const ctXml = buildContentTypes(contentTypes);

  const zippable: Zippable = {};
  const opts = { level, mtime } as const;
  zippable['[Content_Types].xml'] = [strToU8(ctXml), opts];
  for (const [part, data] of parts) {
    zippable[toEntryName(part)] = [data, opts];
  }

  return zipSync(zippable, { level, mtime });
}
