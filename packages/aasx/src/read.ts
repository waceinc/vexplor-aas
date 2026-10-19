/**
 * AASX reading — spec M2.
 *
 * Parses zip + JSON directly, per the measured lesson in linter spec §6-2.
 * (a basyx round-trip load silently drops SML subtrees and submodels)
 */
import { parseEnvironmentXml, xmlMetamodelVersion } from './xml.js';
import {
  detectMetamodelVersion,
  fill,
  parseEnvironment,
  tr,
  type Environment,
  type MetamodelDetection,
} from '@aas/core';
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
   * Whether to raise package structure defects as errors.
   * If false (default), reads with maximum recovery — defect diagnosis is the M5 linter's job.
   */
  strict?: boolean;
  /**
   * Limits for zip-bomb and path-traversal defense (spec VIII). Defaults are used if not specified.
   * Exceeding a limit throws AasxLimitError — it must be handled separately from file format errors (HTTP 413).
   */
  limits?: Partial<AasxLimits>;
}

/** Actual OPC information needed for L1 package rule checks */
export interface OpcSnapshot {
  /** All absolute part names actually present in the ZIP */
  parts: string[];
  /** Part names declared in [Content_Types].xml Overrides */
  contentTypeOverrides: string[];
  /** Extensions declared in [Content_Types].xml Defaults (lowercase, without dot) */
  contentTypeDefaults: string[];
  /** Target part names referenced by all .rels files */
  relationshipTargets: string[];
}

export interface ReadResult extends AasxPackage {
  /** Package structure problems found while reading. Populated only when strict=false */
  warnings: string[];
  /** Package snapshot that can be passed as-is to the linter's L1 rules */
  opc: OpcSnapshot;
  /**
   * Metamodel version of the body. XML declares it in its namespace; JSON has no marker, so it is inferred from
   * content (the lowest version that can hold it) and marked `inferred`.
   */
  metamodel: MetamodelDetection;
}

/**
 * Parses one part; any failure becomes an AasxReadError naming the part.
 * Important: a hostile file must end as "this file cannot be read" (400), never as a raw parser error or a stack
 *    overflow that the server reports as its own fault (500) — red-team L7 / L8, 2026-10-16.
 */
function readPart<T>(part: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AasxReadError || error instanceof AasxLimitError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AasxReadError(fill(tr('{0} 파트를 읽지 못했습니다: {1}'), { 0: part, 1: message.slice(0, 500) }));
  }
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
    // The filter runs before decompression. Blocking here is what keeps memory from ballooning
    entries = unzipSync(buffer, { filter: createEntryGuard(limits) });
  } catch (e) {
    if (e instanceof AasxLimitError) throw e; // Exceeding a limit is not a format error
    throw new AasxReadError(fill(tr('AASX ZIP을 열 수 없습니다: {0}'), { 0: (e as Error).message }));
  }

  const parts = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // Directory entry
    parts.set(toPartName(name), data);
  }

  // ① [Content_Types].xml
  const ctPart = '/[Content_Types].xml';
  const ctRaw = parts.get(ctPart);
  let contentTypes: ContentTypes = { defaults: new Map(), overrides: new Map() };
  if (ctRaw) contentTypes = readPart(ctPart, () => parseContentTypes(strFromU8(ctRaw)));
  else fail(tr('[Content_Types].xml이 없습니다.'));

  // ② Parse all relationship files
  const relsByOwner = new Map<string, Relationship[]>();
  for (const [part, data] of parts) {
    if (!part.includes('/_rels/') || !part.endsWith('.rels')) continue;
    relsByOwner.set(part, readPart(part, () => parseRelationships(strFromU8(data), ownerDirOfRels(part))));
  }
  const relsOf = (part: string): Relationship[] => relsByOwner.get(relsPathFor(part)) ?? [];

  const rootRels = relsByOwner.get('/_rels/.rels') ?? [];
  if (rootRels.length === 0) fail(tr('_rels/.rels가 없거나 비어 있습니다.'));

  // ③ Follow the aasx-origin -> aas-spec (data.json) chain
  const originRel = rootRels.find((r) => r.type === REL_TYPE.origin);
  const originPart = originRel?.target ?? ORIGIN_PART;
  if (!originRel) fail(tr('aasx-origin 관계가 없습니다.'));

  const specRel = relsOf(originPart).find((r) => r.type === REL_TYPE.spec);
  const specPart = specRel?.target ?? DEFAULT_SPEC_PART;
  if (!specRel) fail(fill(tr('aas-spec 관계가 없습니다. {0}로 가정합니다.'), { 0: DEFAULT_SPEC_PART }));

  const specRaw = parts.get(specPart);
  if (!specRaw) throw new AasxReadError(fill(tr('AAS 본문 파트를 찾을 수 없습니다: {0}'), { 0: specPart }));

  // Existing tools (Package Explorer, etc.) often provide AASX saved as XML. We support reading only —
  // saving stays JSON (we do not split the lossless round-trip path in two)
  const lower = specPart.toLowerCase();
  const isXml = lower.endsWith('.xml');
  if (isXml) {
    warnings.push(
      fill(tr('XML 버전을 읽었습니다({0}). 저장할 때는 JSON({1})으로 씁니다.'), { 0: specPart, 1: DEFAULT_SPEC_PART }),
    );
  }
  if (!isXml && !lower.endsWith('.json')) {
    throw new AasxReadError(fill(tr('알 수 없는 본문 형식입니다: {0} (.json 또는 .xml)'), { 0: specPart }));
  }
  const specText = strFromU8(specRaw);
  const environment: Environment = readPart(specPart, () =>
    isXml ? parseEnvironmentXml(specText) : parseEnvironment(specText),
  );
  const metamodel = detectedVersion(environment, isXml ? specText : undefined, specPart, warnings);

  // ④ Thumbnail
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
      fail(fill(tr('썸네일 관계는 있으나 파트가 없습니다: {0}'), { 0: thumbRel.target }));
    }
  }

  // ⑤ Attachments
  const supplementaryFiles: AasxFile[] = [];
  for (const rel of relsOf(specPart)) {
    if (rel.type !== REL_TYPE.suppl) continue;
    const data = parts.get(rel.target);
    if (!data) {
      fail(fill(tr('첨부 파일 관계는 있으나 파트가 없습니다: {0}'), { 0: rel.target }));
      continue;
    }
    supplementaryFiles.push({
      part: rel.target,
      contentType: contentTypeOf(contentTypes, rel.target) ?? guessContentType(rel.target),
      data,
    });
    consumed.add(rel.target);
  }

  // ⑥ Preserve everything else as-is (lossless)
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
     * Important: even when read from XML, the body part name **is switched to JSON.**
     * Saving is JSON-only — if the name stayed `.xml`, the result would be a package
     * "named xml but containing json", which other tools cannot open.
     */
    specPart: isXml ? DEFAULT_SPEC_PART : specPart,
    supplementaryFiles,
    extraParts,
    warnings,
    metamodel,
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

/**
 * The body's metamodel version. A namespace wins; the content is still scanned so a 3.0-declared file holding a 3.2
 * value carries that evidence for the checks to report.
 */
function detectedVersion(
  environment: Environment,
  xmlText: string | undefined,
  specPart: string,
  warnings: string[],
): MetamodelDetection {
  const fromContent = detectMetamodelVersion(environment);
  if (xmlText === undefined) return fromContent;
  const declared = xmlMetamodelVersion(xmlText);
  if (declared === undefined) {
    warnings.push(
      fill(tr('{0}의 XML 네임스페이스로 메타모델 버전을 알 수 없어 내용으로 추정했습니다(V{1}).'), {
        0: specPart,
        1: fromContent.version,
      }),
    );
    return fromContent;
  }
  return { version: declared, source: 'namespace', inferred: false, fits: fromContent.fits, evidence: fromContent.evidence };
}

/** Shortcut when only aasx/data.json is needed (for structure scanning) */
export function readEnvironment(buffer: Uint8Array): Environment {
  return readAasx(buffer).environment;
}
