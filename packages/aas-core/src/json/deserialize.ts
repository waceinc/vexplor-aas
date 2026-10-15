/**
 * AAS V3.0 JSON → Environment.
 *
 * Design principle — lossless. Since the acceptance criterion is "0 Validator findings after loading and re-saving
 * a golden file", the parser never discards unknown fields. Rule violations are not judged here; the M5 linter
 * handles them.
 * (Linter spec §6-2: a basyx round-trip load drops SML subtrees, so we parse directly)
 */
import { AAS_SUBMODEL_ELEMENTS, type AasSubmodelElementType } from '../types/common.js';
import type { ConceptDescription } from '../types/concept.js';
import type { Environment } from '../types/environment.js';
import type { AssetAdministrationShell } from '../types/shell.js';
import type { Submodel, SubmodelElement } from '../types/submodel.js';
import { fill, tr } from '../i18n/index.js';
import { jsonDepthExceeds } from './depth.js';

export interface ParseIssue {
  /** JSON Pointer */
  pointer: string;
  message: string;
}

export class AasParseError extends Error {
  readonly issues: ParseIssue[];
  constructor(issues: ParseIssue[]) {
    const head = issues.slice(0, 5).map((i) => `  ${i.pointer}: ${i.message}`).join('\n');
    super(`${fill(tr('AAS JSON 파싱 실패 ({0}건)'), { 0: issues.length })}\n${head}${issues.length > 5 ? '\n  ...' : ''}`);
    this.name = 'AasParseError';
    this.issues = issues;
  }
}

const SME_TYPES = new Set<string>(AAS_SUBMODEL_ELEMENTS);

/**
 * Deepest SubmodelElement nesting accepted (red-team L7, 2026-10-16).
 * Important: the checks below recurse per level; a file nested a few thousand levels deep overflowed the call stack
 *    and surfaced as a 500. Real equipment models stay far below 64 levels — this only refuses hostile files.
 */
export const MAX_ELEMENT_DEPTH = 64;

/**
 * Deepest JSON nesting accepted in an environment text — each element level costs two JSON levels (the element object
 * and its `value` array), plus the envelope (environment, submodels, submodel, submodelElements, …).
 */
export const MAX_JSON_DEPTH = MAX_ELEMENT_DEPTH * 2 + 16;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates a SubmodelElement.
 * Only checks the modelType discriminator and passes the remaining fields through unchanged.
 */
function checkElement(node: unknown, pointer: string, issues: ParseIssue[], depth = 1): void {
  if (depth > MAX_ELEMENT_DEPTH) {
    issues.push({ pointer, message: fill(tr('요소가 너무 깊게 겹쳐 있습니다 — {0}단계까지 받습니다.'), { 0: MAX_ELEMENT_DEPTH }) });
    return;
  }
  if (!isRecord(node)) {
    issues.push({ pointer, message: tr('SubmodelElement는 객체여야 합니다.') });
    return;
  }
  const mt = node['modelType'];
  if (typeof mt !== 'string') {
    issues.push({ pointer, message: tr('modelType이 없습니다.') });
    return;
  }
  if (!SME_TYPES.has(mt)) {
    issues.push({ pointer, message: fill(tr('알 수 없는 modelType입니다: {0}'), { 0: mt }) });
    return;
  }

  // Recursively checks child containers — keeps everything, drops nothing
  const recurse = (field: string): void => {
    const children = node[field];
    if (children === undefined) return;
    if (!Array.isArray(children)) {
      issues.push({ pointer: `${pointer}/${field}`, message: fill(tr('{0}는 배열이어야 합니다.'), { 0: field }) });
      return;
    }
    children.forEach((c, i) => checkElement(c, `${pointer}/${field}/${i}`, issues, depth + 1));
  };

  if (mt === 'SubmodelElementCollection' || mt === 'SubmodelElementList') recurse('value');
  if (mt === 'Entity') recurse('statements');
  if (mt === 'AnnotatedRelationshipElement') recurse('annotations');
  if (mt === 'Operation') {
    for (const f of ['inputVariables', 'outputVariables', 'inoutputVariables']) {
      const vars = node[f];
      if (vars === undefined) continue;
      if (!Array.isArray(vars)) {
        issues.push({ pointer: `${pointer}/${f}`, message: fill(tr('{0}는 배열이어야 합니다.'), { 0: f }) });
        continue;
      }
      vars.forEach((v, i) => {
        if (isRecord(v) && v['value'] !== undefined) {
          checkElement(v['value'], `${pointer}/${f}/${i}/value`, issues, depth + 1);
        }
      });
    }
  }
}

function checkIdentifiable(
  node: unknown,
  pointer: string,
  expectedModelType: string,
  issues: ParseIssue[],
): void {
  if (!isRecord(node)) {
    issues.push({ pointer, message: fill(tr('{0}는 객체여야 합니다.'), { 0: expectedModelType }) });
    return;
  }
  if (typeof node['id'] !== 'string' || node['id'].length === 0) {
    issues.push({ pointer, message: tr('id가 없습니다. Identifiable은 전역 id가 필수입니다.') });
  }
  const mt = node['modelType'];
  if (mt !== undefined && mt !== expectedModelType) {
    issues.push({ pointer, message: fill(tr('modelType 불일치: {0} (기대값 {1})'), { 0: String(mt), 1: expectedModelType }) });
  }
}

export interface ParseOptions {
  /**
   * Fills in modelType for Identifiables missing it, based on their container position.
   * Enabled by default because some AASX Package Explorer outputs omit the top-level modelType.
   */
  fillMissingModelType?: boolean;
}

/** Converts a JSON string or an already-parsed object to an Environment */
export function parseEnvironment(input: string | unknown, options: ParseOptions = {}): Environment {
  const { fillMissingModelType = true } = options;
  // Important: the depth is checked on the text before anything recursive runs — see depth.ts
  if (typeof input === 'string' && jsonDepthExceeds(input, MAX_JSON_DEPTH)) {
    throw new AasParseError([
      { pointer: '', message: fill(tr('요소가 너무 깊게 겹쳐 있습니다 — {0}단계까지 받습니다.'), { 0: MAX_ELEMENT_DEPTH }) },
    ]);
  }
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input;

  if (!isRecord(raw)) throw new AasParseError([{ pointer: '', message: tr('최상위는 객체여야 합니다.') }]);

  const issues: ParseIssue[] = [];
  const section = (key: string, modelType: string): unknown[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      issues.push({ pointer: `/${key}`, message: fill(tr('{0}는 배열이어야 합니다.'), { 0: key }) });
      return [];
    }
    v.forEach((item, i) => {
      checkIdentifiable(item, `/${key}/${i}`, modelType, issues);
      if (fillMissingModelType && isRecord(item) && item['modelType'] === undefined) {
        item['modelType'] = modelType;
      }
    });
    return v;
  };

  const shells = section('assetAdministrationShells', 'AssetAdministrationShell');
  const submodels = section('submodels', 'Submodel');
  const cds = section('conceptDescriptions', 'ConceptDescription');

  submodels.forEach((sm, i) => {
    if (!isRecord(sm)) return;
    const elems = sm['submodelElements'];
    if (elems === undefined) return;
    if (!Array.isArray(elems)) {
      issues.push({ pointer: `/submodels/${i}/submodelElements`, message: tr('submodelElements는 배열이어야 합니다.') });
      return;
    }
    elems.forEach((e, j) => checkElement(e, `/submodels/${i}/submodelElements/${j}`, issues));
  });

  if (issues.length > 0) throw new AasParseError(issues);

  const env: Environment = {};
  if (shells.length > 0) env.assetAdministrationShells = shells as AssetAdministrationShell[];
  if (submodels.length > 0) env.submodels = submodels as Submodel[];
  if (cds.length > 0) env.conceptDescriptions = cds as ConceptDescription[];
  return env;
}

/** Determines whether a modelType belongs to the SubmodelElement family */
export function isSubmodelElementType(t: string): t is AasSubmodelElementType {
  return SME_TYPES.has(t);
}

export type { SubmodelElement };
