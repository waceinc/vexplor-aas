/**
 * Maintenance plan export `vexplor.maintenancePlan/1` — the CMMS job-plan shape (design §4.4, CMMS §4, T14).
 *
 * A plan is a task-list template, not a schedule. `interval` is filled only when the model holds an explicit interval
 * value **and** unit; otherwise `interval: null, intervalStatus: "missing"` (INT-3). The idShort
 * "…ForSpecificInterval" is a name, not a value — nothing is inferred from it. Steps keep model order; tool and
 * consumable references resolve to the business keys `ToolID` / `ConsumableID`; what does not resolve is reported in
 * `unresolved`, never dropped. No costs, no prices (ERP §7.1).
 */
import { createHash } from 'node:crypto';
import type { Environment } from '@aas/core';
import { canonicalJson } from '../ids.js';
import type { FileLink, FileResolver } from './documents.js';
import {
  asArray,
  booleanOf,
  child,
  childrenOf,
  findElement,
  findSubmodel,
  idShortOf,
  locatedChildren,
  modelTypeOf,
  numberOf,
  semanticIdOf,
  shellsOf,
  submodelsOf,
  textOf,
  topElements,
  walk,
  type Json,
  type Located,
} from './elements.js';
import { unitOf } from './units.js';

export interface PlanStep {
  seq: number;
  stepId: string | null;
  name: string | null;
  instruction: string | null;
  duration: { value: number; unit: string | null } | null;
  toolIds: string[];
  consumableIds: string[];
  documents: FileLink[];
  signatureRequired: boolean | null;
  isLast: boolean | null;
}

export interface MaintenancePlan {
  maintenanceId: string | null;
  taskName: string | null;
  source: string | null;
  safety: string | null;
  interval: { value: number; unit: string; basis: string | null } | null;
  intervalStatus: 'present' | 'missing';
  technicians: number | null;
  qualification: string | null;
  steps: PlanStep[];
  tools: { id: string; name: string | null }[];
  consumables: { id: string; name: string | null }[];
  unresolved: string[];
  sourceRef: { submodelId: string; idShortPath: string };
  revision: number;
  contentHash: string;
}

const PLAN = /MaintenanceInstructionsFor/i;

export function maintenanceSubmodel(environment: Environment): Json | undefined {
  return findSubmodel(submodelsOf(environment, shellsOf(environment)[0]), ['MaintenanceInstructions'], /MaintenanceInstructions/);
}

/** Plan collections of the submodel (top level or inside a list), model order */
export function planElements(submodel: Json): Located[] {
  return walk(topElements(submodel)).filter(
    (item) => modelTypeOf(item.element) === 'SubmodelElementCollection' && (PLAN.test(idShortOf(item.element) ?? '') || PLAN.test(semanticIdOf(item.element) ?? '')),
  );
}

/**
 * Explicit interval: a collection named …Interval… holding a numeric `…Value…` and a non-empty `…Unit…`, or a numeric
 * Property named …Interval… whose ConceptDescription carries a unit. The step list is not searched.
 */
export function explicitInterval(environment: Environment, plan: Located): MaintenancePlan['interval'] {
  const candidates = walk(locatedChildren(plan).filter((item) => idShortOf(item.element) !== 'ListMaintenanceSteps'));
  for (const item of candidates) {
    if (!/interval/i.test(idShortOf(item.element) ?? '')) continue;
    if (modelTypeOf(item.element) === 'Property') {
      const value = numberOf(item.element);
      const unit = unitOf(environment, item.element);
      if (value !== null && unit !== null) return { value, unit, basis: null };
      continue;
    }
    const parts = childrenOf(item.element);
    const value = numberOf(parts.find((part) => /value/i.test(idShortOf(part) ?? '')));
    const unit = textOf(parts.find((part) => /unit/i.test(idShortOf(part) ?? '')), 'en');
    const basis = textOf(parts.find((part) => /basis|type/i.test(idShortOf(part) ?? '')), 'en');
    if (value !== null && unit !== null) return { value, unit, basis };
  }
  return null;
}

/**
 * Follows a ModelReference. Per key: the child with that idShort; inside a list, an integer key is an index, and a
 * key ending in `_<n>` (the fixtures name list items that way in references) is taken as index n when no idShort matches.
 */
export function resolveReference(environment: Environment, reference: Json | undefined): Json | undefined {
  const keys = asArray(reference?.['keys']);
  const first = keys[0];
  if (!first || first['type'] !== 'Submodel') return undefined;
  const submodel = asArray(environment.submodels as unknown).find((sm) => sm['id'] === first['value']);
  if (!submodel) return undefined;
  let children = asArray(submodel['submodelElements']);
  let parent: Json | undefined;
  let found: Json | undefined;
  for (const key of keys.slice(1)) {
    const value = String(key['value'] ?? '');
    found = children.find((item) => idShortOf(item) === value);
    if (!found && parent && modelTypeOf(parent) === 'SubmodelElementList') {
      const index = /^\d+$/.test(value) ? Number(value) : Number(/_(\d+)$/.exec(value)?.[1] ?? NaN);
      if (Number.isInteger(index)) found = children[index];
    }
    if (!found) return undefined;
    parent = found;
    children = childrenOf(found);
  }
  return found;
}

function referenceLabel(reference: Json | undefined): string {
  return asArray(reference?.['keys']).map((key) => String(key['value'] ?? '')).join('/');
}

function businessKey(element: Json | undefined, idShort: string): string | null {
  return element ? textOf(findElement([{ element, path: '' }], [], [idShort])?.element, 'en') : null;
}

function catalogue(submodel: Json, listName: string, idName: string, nameName: string, lang: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const list = topElements(submodel).find((item) => idShortOf(item.element) === listName);
  for (const entry of list ? locatedChildren(list) : []) {
    const id = businessKey(entry.element, idName);
    if (id !== null && !out.has(id)) out.set(id, textOf(child(entry, nameName)?.element, lang));
  }
  return out;
}

export function readMaintenancePlans(environment: Environment, lang: string, revision: number, resolveFile: FileResolver): MaintenancePlan[] {
  const submodel = maintenanceSubmodel(environment);
  if (!submodel) return [];
  const submodelId = String(submodel['id']);
  const toolNames = catalogue(submodel, 'MaintenanceToolList', 'ToolID', 'ToolName', lang);
  const consumableNames = catalogue(submodel, 'MaintenanceConsumablesList', 'ConsumableID', 'ConsumableName', lang);
  const plans: MaintenancePlan[] = [];

  for (const plan of planElements(submodel)) {
    const basic = child(plan, 'BasicMaintenanceInformation') ?? plan;
    const technicians = child(plan, 'MaintenanceTechnicians');
    const unresolved: string[] = [];
    const tools = new Set<string>();
    const consumables = new Set<string>();
    const stepList = child(plan, 'ListMaintenanceSteps');
    const stepItems = stepList ? locatedChildren(stepList) : [];
    const steps: PlanStep[] = stepItems.map((step, index) => {
      const refs = (prefix: string, idName: string, into: Set<string>): string[] => {
        const ids: string[] = [];
        for (const item of locatedChildren(step)) {
          if (modelTypeOf(item.element) !== 'ReferenceElement' || !(idShortOf(item.element) ?? '').startsWith(prefix)) continue;
          const reference = item.element['value'] as Json | undefined;
          const id = businessKey(resolveReference(environment, reference), idName);
          if (id === null) unresolved.push(referenceLabel(reference));
          else if (!ids.includes(id)) {
            ids.push(id);
            into.add(id);
          }
        }
        return ids;
      };
      const duration = child(step, 'EstimatedDurationTimeMaintenanceStep');
      const durationValue = duration ? numberOf(child(duration, 'ValueEstimatedDurationTimeMaintenanceStep')?.element) : null;
      return {
        seq: index + 1,
        stepId: textOf(child(step, 'MaintenanceStepID')?.element, lang),
        name: textOf(child(step, 'MaintenanceStepName')?.element, lang),
        instruction: textOf(child(step, 'InstructionMaintenanceStep')?.element, lang),
        duration:
          duration && durationValue !== null
            ? { value: durationValue, unit: textOf(child(duration, 'UnitEstimatedDurationTimeMaintenanceStep')?.element, lang) }
            : null,
        toolIds: refs('ToolsForMaintenanceStep', 'ToolID', tools),
        consumableIds: refs('ConsumablesForMaintenanceStep', 'ConsumableID', consumables),
        documents: locatedChildren(step)
          .filter((item) => modelTypeOf(item.element) === 'File' && (idShortOf(item.element) ?? '').startsWith('RelatedDocumentOrFile'))
          .map((item) => resolveFile(submodelId, item.path, item.element)),
        signatureRequired: booleanOf(child(step, 'DocumentationSignatureMandatory')?.element),
        isLast: booleanOf(child(step, 'EndOfMaintenance')?.element),
      };
    });
    const interval = explicitInterval(environment, plan);
    const body = {
      maintenanceId: textOf(child(basic, 'MaintenanceID')?.element, lang),
      taskName: textOf(child(basic, 'NameOfMaintenance')?.element, lang),
      source: textOf(child(basic, 'SourceOfMaintenanceInstructions')?.element, lang),
      safety: textOf(child(basic, 'SafetyRegulationsToBeObserved')?.element, lang),
      interval,
      intervalStatus: interval ? ('present' as const) : ('missing' as const),
      technicians: technicians ? numberOf(child(technicians, 'NumberOfRequiredTechnicians')?.element) : null,
      qualification: technicians ? textOf(child(technicians, 'RequiredQualification')?.element, lang) : null,
      steps,
      tools: [...tools].sort().map((id) => ({ id, name: toolNames.get(id) ?? null })),
      consumables: [...consumables].sort().map((id) => ({ id, name: consumableNames.get(id) ?? null })),
      unresolved,
      sourceRef: { submodelId, idShortPath: plan.path },
    };
    // The hash leaves out download URLs — they change with AAS_PUBLIC_URL, the plan does not
    const hashed = {
      ...body,
      steps: steps.map((step) => ({
        ...step,
        documents: step.documents.map((document) => ({ fileName: document.fileName, sha256: document.sha256, available: document.available })),
      })),
    };
    plans.push({ ...body, revision, contentHash: `sha256:${createHash('sha256').update(canonicalJson(hashed)).digest('hex')}` });
  }
  return plans.sort(
    (a, b) => (a.maintenanceId ?? '￿').localeCompare(b.maintenanceId ?? '￿') || a.sourceRef.idShortPath.localeCompare(b.sourceRef.idShortPath),
  );
}

/** One CSV row per step (a plan without steps still gets one row) — MAINTENANCE_V1_COLUMNS */
export function maintenanceRows(plans: readonly MaintenancePlan[]): Record<string, string | number | boolean | null | string[]>[] {
  const rows: Record<string, string | number | boolean | null | string[]>[] = [];
  for (const plan of plans) {
    const head = {
      maintenanceId: plan.maintenanceId,
      taskName: plan.taskName,
      interval: plan.interval ? `${plan.interval.value} ${plan.interval.unit}` : null,
      intervalStatus: plan.intervalStatus,
      technicians: plan.technicians,
      qualification: plan.qualification,
      safety: plan.safety,
      sourceRef: `${plan.sourceRef.submodelId}#${plan.sourceRef.idShortPath}`,
    };
    const steps = plan.steps.length > 0 ? plan.steps : [undefined];
    for (const step of steps) {
      rows.push({
        ...head,
        stepSeq: step?.seq ?? null,
        stepId: step?.stepId ?? null,
        stepName: step?.name ?? null,
        instruction: step?.instruction ?? null,
        durationValue: step?.duration?.value ?? null,
        durationUnit: step?.duration?.unit ?? null,
        toolIds: step?.toolIds ?? [],
        consumableIds: step?.consumableIds ?? [],
        documents: (step?.documents ?? []).map((document) => document.url ?? document.fileName ?? ''),
        signatureRequired: step?.signatureRequired ?? null,
      });
    }
  }
  return rows;
}
