/**
 * L2 — constraints new in metamodel V3.2 (IDTA-01001 V3.2 change notes, "Changes V3.2 vs. V3.1.2").
 *
 * Both are judged only for 3.2 files: a 3.0 or 3.1 file was valid without them, and holding it to a rule its version
 * does not have would be the same kind of false alarm as AASd-090 on 3.1 files.
 * The JSON schemas do not encode either, so the core's version table (metamodel/features.ts) cannot see them —
 * this is the only place they are checked.
 */
import type { SubmodelElement } from '@aas/core';
import { fill, KEY_TYPES, tr, type VisitedNode } from '@aas/core';
import type { LintContext, Rule } from '../types.js';
import { atLeast } from '../version.js';

// i18n-ignore — standard document name
const SOURCE_32 = 'IDTA-01001 V3.2';

/** AasReferables (Part 1 V3.2 §5.3.11) — every KeyTypes value except GlobalReference and FragmentReference */
const AAS_REFERABLES = new Set<string>(KEY_TYPES.filter((type) => type !== 'GlobalReference' && type !== 'FragmentReference'));

const VARIABLE_FIELDS = ['inputVariables', 'outputVariables', 'inoutputVariables'] as const;

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Children of a container element — the same fields the core traverser follows */
function childrenOf(node: Raw): { field: string; items: unknown[] } | undefined {
  switch (node['modelType']) {
    case 'SubmodelElementCollection':
    case 'SubmodelElementList':
      return Array.isArray(node['value']) ? { field: 'value', items: node['value'] } : undefined;
    case 'Entity':
      return Array.isArray(node['statements']) ? { field: 'statements', items: node['statements'] } : undefined;
    case 'AnnotatedRelationshipElement':
      return Array.isArray(node['annotations']) ? { field: 'annotations', items: node['annotations'] } : undefined;
    default:
      return undefined;
  }
}

/**
 * Every element held in an operation variable (the variable's value and everything below it, operations nested in
 * them included). ctx.elements stops at an Operation, because those elements are not part of the submodel's own tree.
 */
export function operationVariableElements(ctx: LintContext): VisitedNode[] {
  const out: VisitedNode[] = [];
  const fromOperation = (op: VisitedNode): void => {
    const raw = op.node as unknown as Raw;
    for (const field of VARIABLE_FIELDS) {
      const variables = raw[field];
      if (!Array.isArray(variables)) continue;
      variables.forEach((variable, i) => {
        if (!isRaw(variable) || !isRaw(variable['value'])) return;
        visit(variable['value'], `${op.pointer}/${field}/${i}/value`, `${op.kosmoPath}/${field}/${i}/value`, op, op.depth + 1);
      });
    }
  };
  const visit = (node: Raw, pointer: string, kosmoPath: string, parent: VisitedNode, depth: number): void => {
    const element = node as unknown as SubmodelElement;
    const label = typeof node['idShort'] === 'string' ? node['idShort'] : pointer.slice(pointer.lastIndexOf('/') + 1);
    const visited: VisitedNode = {
      node: element,
      pointer,
      kosmoPath,
      submodel: parent.submodel,
      parent: parent.node,
      idShortPath: `${parent.idShortPath}.${label}`,
      depth,
    };
    out.push(visited);
    if (node['modelType'] === 'Operation') fromOperation(visited);
    const children = childrenOf(node);
    children?.items.forEach((child, i) => {
      if (!isRaw(child)) return;
      const idShort = typeof child['idShort'] === 'string' ? `(${child['idShort']})` : '';
      visit(child, `${pointer}/${children.field}/${i}`, `${kosmoPath}/${children.field}/${i}${idShort}`, visited, depth + 1);
    });
  };
  for (const v of ctx.elements) if (v.node.modelType === 'Operation') fromOperation(v);
  return out;
}

/** Calls fn for every Reference object anywhere in the environment */
function eachReference(root: unknown, fn: (ref: Raw, pointer: string) => void): void {
  const stack: [unknown, string][] = [[root, '']];
  while (stack.length > 0) {
    const [node, pointer] = stack.pop()!;
    if (Array.isArray(node)) {
      node.forEach((item, i) => stack.push([item, `${pointer}/${i}`]));
      continue;
    }
    if (!isRaw(node)) continue;
    if ((node['type'] === 'ExternalReference' || node['type'] === 'ModelReference') && Array.isArray(node['keys'])) {
      fn(node, pointer);
    }
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'object' && child !== null) stack.push([child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`]);
    }
  }
}

/**
 * AASd-137 — every Key/type of an external reference is not one of AasReferables (Part 1 V3.2 §5.3.10).
 *
 * Important: AASd-122 (first key) and AASd-124 (last key) already speak about the first and last key of the
 *    semanticIds they check (rule AASd-121~128). Those two positions are left to that rule there, so one wrong key
 *    is not reported twice; every other key and every other reference (supplemental semanticIds, data specification
 *    references, ReferenceElement values …) is checked here.
 */
export const aasd137ExternalReferenceKeys: Rule = {
  id: 'AASd-137',
  layer: 'L2',
  get title() {
    return tr('ExternalReference 의 어느 키도 AAS 요소 종류(AasReferables)일 수 없다 — 메타모델 3.2');
  },
  get source() {
    return fill(tr('{0} 제약 AASd-137 (변경 기록 #592) — 3.2 파일만'), { 0: SOURCE_32 });
  },
  check(ctx, report) {
    if (!atLeast(ctx, '3.2')) return;
    const coveredEnds = new Set<string>();
    (ctx.environment.submodels ?? []).forEach((_, i) => coveredEnds.add(`/submodels/${i}/semanticId`));
    for (const v of ctx.elements) coveredEnds.add(`${v.pointer}/semanticId`);

    eachReference(ctx.environment, (ref, pointer) => {
      if (ref['type'] !== 'ExternalReference') return;
      const keys = ref['keys'] as unknown[];
      keys.forEach((key, i) => {
        if (!isRaw(key) || typeof key['type'] !== 'string' || !AAS_REFERABLES.has(key['type'])) return;
        if (coveredEnds.has(pointer) && (i === 0 || i === keys.length - 1)) return;
        report({
          severity: 'error',
          elementType: 'Reference',
          key: typeof key['value'] === 'string' ? key['value'] : String(i),
          pointer: `${pointer}/keys/${i}/type`,
          kosmoPath: `${pointer}/keys/${i}/type`,
          message: fill(tr('ExternalReference 의 {0}번째 키 타입이 AAS 요소 종류입니다: {1}'), { 0: i + 1, 1: key['type'] }),
          remedy: tr(
            '바깥 대상을 가리키는 참조의 키는 GlobalReference(또는 마지막 자리의 FragmentReference)만 쓸 수 있습니다(AASd-137). AAS 안의 요소를 가리키려면 ModelReference 로 바꾸십시오.',
          ),
          fixable: false,
        });
      });
    });
  },
};

/**
 * AASd-138 — a SubmodelElementList within a Submodel of kind=Template, or as part of an OperationVariable, has
 * exactly one element (Part 1 V3.2 §5.3.7.15).
 *
 * Note: KOSMO deliverables are kind=Template throughout, so a KOSMO file written as 3.2 must hold this — a 3.1 file
 * (what KOSMO asks for) does not.
 */
export const aasd138TemplateList: Rule = {
  id: 'AASd-138',
  layer: 'L2',
  get title() {
    return tr('Template 서브모델 · Operation 변수 안의 SubmodelElementList 는 요소를 정확히 1개 가진다 — 메타모델 3.2');
  },
  get source() {
    return fill(tr('{0} 제약 AASd-138 (변경 기록 #462) — 3.2 파일만'), { 0: SOURCE_32 });
  },
  check(ctx, report) {
    if (!atLeast(ctx, '3.2')) return;
    const inTemplate = ctx.elements.filter((v) => v.submodel.kind === 'Template');
    for (const v of [...inTemplate, ...operationVariableElements(ctx)]) {
      if (v.node.modelType !== 'SubmodelElementList') continue;
      const count = Array.isArray(v.node.value) ? v.node.value.length : 0;
      if (count === 1) continue;
      report({
        severity: 'error',
        elementType: 'SubmodelElementList',
        key: v.node.idShort ?? v.idShortPath,
        pointer: v.pointer,
        kosmoPath: v.kosmoPath,
        message: fill(tr('Template 이나 Operation 변수 안의 SubmodelElementList 에 요소가 {0}개 있습니다 — 정확히 1개여야 합니다.'), { 0: count }),
        remedy: tr(
          '서식(Template)의 리스트는 항목 모양을 보여 주는 견본 1개만 둡니다(AASd-138). 실제 값을 여러 개 넣을 것이면 서브모델 kind 를 Instance 로 바꾸십시오.',
        ),
        fixable: false,
      });
    }
  },
};
