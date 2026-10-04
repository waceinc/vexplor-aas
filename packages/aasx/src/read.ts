/**
 * AASX 읽기 — 기획서 M2.
 *
 * 린터 명세 §6-2의 실측 교훈에 따라 zip + JSON을 직접 파싱한다.
 * (basyx 왕복 로드는 SML 서브트리와 서브모델을 조용히 드롭한다)
 */
import { parseEnvironmentXml } from './xml.js';
import { parseEnvironment, type Environment } from '@aas/core';
import { unzipSync, strFromU8 } from 'fflate';
import {
  contentTypeOf,
  guessContentType,
  ownerDirOfRels,
  parseContentTypes,
  parseRelationships,
  REL_TYPE,
  relsPathFor,
  toEntryName,
  toPartName,
  type ContentTypes,
  type Relationship,
} from './opc.js';
import { DEFAULT_SPEC_PART, ORIGIN_PART, type AasxFile, type AasxPackage } from './package.js';
import { AasxLimitError, createEntryGuard, DEFAULT_LIMITS, type AasxLimits } from './limits.js';

export class AasxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AasxReadError';
  }
}

export interface ReadOptions {
  /**
   * 패키지 구조 결함을 오류로 올릴지 여부.
   * false(기본)면 최대한 복구해서 읽는다 — 결함 진단은 M5 린터가 맡는다.
   */
  strict?: boolean;
  /**
   * 압축 폭탄·경로 탈출 방어 상한(기획서 Ⅷ). 지정하지 않으면 기본값을 쓴다.
   * 상한을 넘으면 AasxLimitError를 던진다 — 파일 형식 오류와 구분해서 다뤄야 한다(HTTP 413).
   */
  limits?: Partial<AasxLimits>;
}

/** L1 패키지 규칙 검사에 필요한 OPC 실측 정보 */
export interface OpcSnapshot {
  /** ZIP에 실재하는 절대 파트명 전부 */
  parts: string[];
  /** [Content_Types].xml Override에 선언된 파트명 */
  contentTypeOverrides: string[];
  /** [Content_Types].xml Default에 선언된 확장자(소문자, 점 없이) */
  contentTypeDefaults: string[];
  /** 모든 .rels가 가리키는 대상 파트명 */
  relationshipTargets: string[];
}

export interface ReadResult extends AasxPackage {
  /** 읽는 중 발견한 패키지 구조 문제. strict=false일 때만 채워진다 */
  warnings: string[];
  /** 린터의 L1 규칙에 그대로 넘길 수 있는 패키지 스냅샷 */
  opc: OpcSnapshot;
}

export function readAasx(buffer: Uint8Array, options: ReadOptions = {}): ReadResult {
  const { strict = false } = options;
  const warnings: string[] = [];
  const fail = (msg: string): void => {
    if (strict) throw new AasxReadError(msg);
    warnings.push(msg);
  };

  const limits: AasxLimits = { ...DEFAULT_LIMITS, ...options.limits };
  let entries: Record<string, Uint8Array>;
  try {
    // 필터는 압축을 풀기 전에 돈다. 여기서 막아야 메모리가 부풀지 않는다
    entries = unzipSync(buffer, { filter: createEntryGuard(limits) });
  } catch (e) {
    if (e instanceof AasxLimitError) throw e; // 상한 초과는 형식 오류가 아니다
    throw new AasxReadError(`AASX ZIP을 열 수 없습니다: ${(e as Error).message}`);
  }

  const parts = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // 디렉터리 엔트리
    parts.set(toPartName(name), data);
  }

  // ① [Content_Types].xml
  const ctPart = '/[Content_Types].xml';
  const ctRaw = parts.get(ctPart);
  let contentTypes: ContentTypes = { defaults: new Map(), overrides: new Map() };
  if (ctRaw) contentTypes = parseContentTypes(strFromU8(ctRaw));
  else fail('[Content_Types].xml이 없습니다.');

  // ② 관계 파일 전부 파싱
  const relsByOwner = new Map<string, Relationship[]>();
  for (const [part, data] of parts) {
    if (!part.includes('/_rels/') || !part.endsWith('.rels')) continue;
    relsByOwner.set(part, parseRelationships(strFromU8(data), ownerDirOfRels(part)));
  }
  const relsOf = (part: string): Relationship[] => relsByOwner.get(relsPathFor(part)) ?? [];

  const rootRels = relsByOwner.get('/_rels/.rels') ?? [];
  if (rootRels.length === 0) fail('_rels/.rels가 없거나 비어 있습니다.');

  // ③ aasx-origin → aas-spec(data.json) 경로 추적
  const originRel = rootRels.find((r) => r.type === REL_TYPE.origin);
  const originPart = originRel?.target ?? ORIGIN_PART;
  if (!originRel) fail('aasx-origin 관계가 없습니다.');

  const specRel = relsOf(originPart).find((r) => r.type === REL_TYPE.spec);
  const specPart = specRel?.target ?? DEFAULT_SPEC_PART;
  if (!specRel) fail(`aas-spec 관계가 없습니다. ${DEFAULT_SPEC_PART}로 가정합니다.`);

  const specRaw = parts.get(specPart);
  if (!specRaw) throw new AasxReadError(`AAS 본문 파트를 찾을 수 없습니다: ${specPart}`);

  // 기존 도구(Package Explorer 등)는 XML로 저장한 AASX를 흔히 준다. 읽기만 지원한다 —
  // 저장은 계속 JSON으로 한다(무손실 왕복 경로를 둘로 늘리지 않는다)
  const lower = specPart.toLowerCase();
  const isXml = lower.endsWith('.xml');
  if (isXml) {
    warnings.push(
      `XML 판을 읽었습니다(${specPart}). 저장할 때는 JSON(${DEFAULT_SPEC_PART})으로 씁니다.`,
    );
  }
  const environment: Environment = isXml
    ? parseEnvironmentXml(strFromU8(specRaw))
    : lower.endsWith('.json')
      ? parseEnvironment(strFromU8(specRaw))
      : (() => {
          throw new AasxReadError(`알 수 없는 본문 형식입니다: ${specPart} (.json 또는 .xml)`);
        })();

  // ④ 썸네일
  const consumed = new Set<string>([ctPart, specPart, originPart, ...relsByOwner.keys()]);
  let thumbnail: AasxFile | undefined;
  const thumbRel = rootRels.find((r) => r.type === REL_TYPE.thumbnail);
  if (thumbRel) {
    const data = parts.get(thumbRel.target);
    if (data) {
      thumbnail = {
        part: thumbRel.target,
        contentType: contentTypeOf(contentTypes, thumbRel.target) ?? guessContentType(thumbRel.target),
        data,
      };
      consumed.add(thumbRel.target);
    } else {
      fail(`썸네일 관계는 있으나 파트가 없습니다: ${thumbRel.target}`);
    }
  }

  // ⑤ 첨부 파일
  const supplementaryFiles: AasxFile[] = [];
  for (const rel of relsOf(specPart)) {
    if (rel.type !== REL_TYPE.suppl) continue;
    const data = parts.get(rel.target);
    if (!data) {
      fail(`첨부 파일 관계는 있으나 파트가 없습니다: ${rel.target}`);
      continue;
    }
    supplementaryFiles.push({
      part: rel.target,
      contentType: contentTypeOf(contentTypes, rel.target) ?? guessContentType(rel.target),
      data,
    });
    consumed.add(rel.target);
  }

  // ⑥ 나머지는 그대로 보존한다 (무손실)
  const extraParts = new Map<string, Uint8Array>();
  for (const [part, data] of parts) {
    if (!consumed.has(part)) extraParts.set(part, data);
  }

  const relationshipTargets = new Set<string>();
  for (const rels of relsByOwner.values()) {
    for (const rel of rels) relationshipTargets.add(rel.target);
  }

  const result: ReadResult = {
    environment,
    /**
     * 🔴 XML로 읽었어도 본문 파트 이름은 **JSON으로 바꿔 둔다.**
     * 저장은 JSON으로만 하기 때문이다 — 이름이 `.xml`인 채로 남으면
     * "이름은 xml인데 안은 json"인 패키지가 나와 다른 도구가 열지 못한다.
     */
    specPart: isXml ? DEFAULT_SPEC_PART : specPart,
    supplementaryFiles,
    extraParts,
    warnings,
    opc: {
      parts: [...parts.keys()],
      contentTypeOverrides: [...contentTypes.overrides.keys()],
      contentTypeDefaults: [...contentTypes.defaults.keys()],
      relationshipTargets: [...relationshipTargets],
    },
  };
  if (thumbnail) result.thumbnail = thumbnail;
  return result;
}

/** aasx/data.json만 필요한 경우의 지름길 (구조 훑기용) */
export function readEnvironment(buffer: Uint8Array): Environment {
  return readAasx(buffer).environment;
}
