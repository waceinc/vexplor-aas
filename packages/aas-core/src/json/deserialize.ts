/**
 * AAS V3.0 JSON → Environment.
 *
 * 설계 원칙 — 무손실. 검수 기준이 "골든 파일을 불러 다시 저장했을 때 Validator 0건"이므로
 * 파서는 모르는 필드를 절대 버리지 않는다. 규칙 위반은 여기서 판단하지 않고 M5 린터가 맡는다.
 * (린터 명세 §6-2: basyx 왕복 로드는 SML 서브트리를 드롭하므로 직접 파싱한다)
 */
import { AAS_SUBMODEL_ELEMENTS, type AasSubmodelElementType } from '../types/common.js';
import type { ConceptDescription } from '../types/concept.js';
import type { Environment } from '../types/environment.js';
import type { AssetAdministrationShell } from '../types/shell.js';
import type { Submodel, SubmodelElement } from '../types/submodel.js';

export interface ParseIssue {
  /** JSON Pointer */
  pointer: string;
  message: string;
}

export class AasParseError extends Error {
  readonly issues: ParseIssue[];
  constructor(issues: ParseIssue[]) {
    const head = issues.slice(0, 5).map((i) => `  ${i.pointer}: ${i.message}`).join('\n');
    super(`AAS JSON 파싱 실패 (${issues.length}건)\n${head}${issues.length > 5 ? '\n  ...' : ''}`);
    this.name = 'AasParseError';
    this.issues = issues;
  }
}

const SME_TYPES = new Set<string>(AAS_SUBMODEL_ELEMENTS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * SubmodelElement를 검증한다.
 * modelType 판별만 확인하고 나머지 필드는 원본 그대로 통과시킨다.
 */
function checkElement(node: unknown, pointer: string, issues: ParseIssue[]): void {
  if (!isRecord(node)) {
    issues.push({ pointer, message: 'SubmodelElement는 객체여야 합니다.' });
    return;
  }
  const mt = node['modelType'];
  if (typeof mt !== 'string') {
    issues.push({ pointer, message: 'modelType이 없습니다.' });
    return;
  }
  if (!SME_TYPES.has(mt)) {
    issues.push({ pointer, message: `알 수 없는 modelType입니다: ${mt}` });
    return;
  }

  // 자식 컨테이너를 재귀 검사한다 — 드롭 없이 전부 살린다
  const recurse = (field: string): void => {
    const children = node[field];
    if (children === undefined) return;
    if (!Array.isArray(children)) {
      issues.push({ pointer: `${pointer}/${field}`, message: `${field}는 배열이어야 합니다.` });
      return;
    }
    children.forEach((c, i) => checkElement(c, `${pointer}/${field}/${i}`, issues));
  };

  if (mt === 'SubmodelElementCollection' || mt === 'SubmodelElementList') recurse('value');
  if (mt === 'Entity') recurse('statements');
  if (mt === 'AnnotatedRelationshipElement') recurse('annotations');
  if (mt === 'Operation') {
    for (const f of ['inputVariables', 'outputVariables', 'inoutputVariables']) {
      const vars = node[f];
      if (vars === undefined) continue;
      if (!Array.isArray(vars)) {
        issues.push({ pointer: `${pointer}/${f}`, message: `${f}는 배열이어야 합니다.` });
        continue;
      }
      vars.forEach((v, i) => {
        if (isRecord(v) && v['value'] !== undefined) {
          checkElement(v['value'], `${pointer}/${f}/${i}/value`, issues);
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
    issues.push({ pointer, message: `${expectedModelType}는 객체여야 합니다.` });
    return;
  }
  if (typeof node['id'] !== 'string' || node['id'].length === 0) {
    issues.push({ pointer, message: 'id가 없습니다. Identifiable은 전역 id가 필수입니다.' });
  }
  const mt = node['modelType'];
  if (mt !== undefined && mt !== expectedModelType) {
    issues.push({ pointer, message: `modelType 불일치: ${String(mt)} (기대값 ${expectedModelType})` });
  }
}

export interface ParseOptions {
  /**
   * modelType이 빠진 Identifiable에 컨테이너 위치로부터 값을 채워 넣는다.
   * AASX Package Explorer 산출물 중 최상위 modelType을 생략한 파일이 있어 기본 활성화한다.
   */
  fillMissingModelType?: boolean;
}

/** JSON 문자열 또는 이미 파싱된 객체를 Environment로 변환한다 */
export function parseEnvironment(input: string | unknown, options: ParseOptions = {}): Environment {
  const { fillMissingModelType = true } = options;
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input;

  if (!isRecord(raw)) throw new AasParseError([{ pointer: '', message: '최상위는 객체여야 합니다.' }]);

  const issues: ParseIssue[] = [];
  const section = (key: string, modelType: string): unknown[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      issues.push({ pointer: `/${key}`, message: `${key}는 배열이어야 합니다.` });
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
      issues.push({ pointer: `/submodels/${i}/submodelElements`, message: 'submodelElements는 배열이어야 합니다.' });
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

/** modelType이 SubmodelElement 계열인지 판별 */
export function isSubmodelElementType(t: string): t is AasSubmodelElementType {
  return SME_TYPES.has(t);
}

export type { SubmodelElement };
