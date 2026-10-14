/**
 * Virtual PLC tag design — reads **any equipment AASX** and creates tags named after that equipment's operational data.
 *
 * The old virtual PLC had 7 roll-forming machine tags hard-coded, so nothing but reference bundle RB01 could be demoed
 * (implementation plan §3.1). With tag names equal to the model's idShort, "Create collection connection" maps the browsed
 * tags straight onto the model slots — any equipment can be demoed through the existing flow, with no new screen.
 *
 * Values oscillate **around the example values written in the model**. Rules are kept to the minimum readable from names.
 *  - Operating state (...State)   RUNNING <-> ALARM (ALARM only inside the alarm window).
 *    ...Status is left alone — RollWearStatus (roll wear status) came out as RUNNING (2026-09-30 demo check)
 *  - Alarm (Alarm...) booleans    on for 5 s every 40 s; codes (...Code) show an E-code only then
 *  - Judgment (Judgment/Result)   OK, NG once in ten
 *  - Cumulative (Cumulative/Count/Hours/Energy)  grows over time. Defect counts (NG/Defect/Reject...Count) once per ten cycles
 *  - Other numbers      example value +/-3% sine wave (centered on 50 if there is no example value)
 *  - Other text         example value as-is
 *
 * Important: **this is a simulation.** These values must not be used as measurements (implementation plan §3.4-3). It is also stated in the server name.
 */

/** Only what the design needs — does not depend on @aas/core types */
interface ElementLike {
  modelType?: string;
  idShort?: string;
  valueType?: string;
  value?: unknown;
  statements?: unknown;
}
interface EnvironmentLike {
  assetAdministrationShells?: { idShort?: string }[];
  submodels?: { idShort?: string; submodelElements?: ElementLike[] }[];
}

export type SimDataType = 'Double' | 'Int32' | 'Boolean' | 'String';

export interface SimTag {
  /** OPC UA browse name = the model's idShort */
  name: string;
  /** NodeId string unique within the equipment — appended after `s=` */
  nodeId: string;
  /** Path from the submodel (for human cross-checking) */
  path: string;
  dataType: SimDataType;
  /** Elapsed seconds -> value */
  valueAt: (seconds: number) => number | boolean | string;
}

export interface SimMachine {
  /** OPC UA object name = AAS idShort */
  name: string;
  tags: SimTag[];
}

const ALARM_PERIOD = 40;
const ALARM_WINDOW = 5;
const inAlarm = (t: number): boolean => t % ALARM_PERIOD < ALARM_WINDOW;

function dataTypeOf(valueType: string | undefined): SimDataType {
  const vt = (valueType ?? '').replace(/^xs:/, '');
  if (vt === 'boolean') return 'Boolean';
  if (['double', 'float', 'decimal'].includes(vt)) return 'Double';
  if (/int|long|short|byte/i.test(vt)) return 'Int32';
  return 'String';
}

/** Value rule for a single tag */
export function valueRule(name: string, dataType: SimDataType, example: unknown): (t: number) => number | boolean | string {
  const base = Number(example);
  const hasBase = example !== undefined && example !== '' && Number.isFinite(base);
  const lower = name.toLowerCase();

  if (dataType === 'Boolean') {
    if (/alarm|fault|error|warn/.test(lower)) return (t) => inAlarm(t);
    return () => example === 'false' ? false : true;
  }
  if (dataType === 'String') {
    if (/state$/.test(lower)) return (t) => (inAlarm(t) ? 'ALARM' : 'RUNNING');
    if (/code$/.test(lower)) return (t) => (inAlarm(t) ? 'E102' : 'E000');
    if (/judg|result/.test(lower)) return (t) => (Math.floor(t / 3) % 10 === 9 ? 'NG' : 'OK');
    const text = typeof example === 'string' && example !== '' ? example : 'SIM';
    return () => text;
  }
  // Numbers
  const round = (v: number): number => (dataType === 'Int32' ? Math.round(v) : Number(v.toFixed(2)));
  // Defect counts grow in step with the NG judgment cycle (once per ten 3-second cycles) — if they grew at the same rate
  // as the production count, the yield would compute as 0% (found in the 2026-09-30 Use-Case KPI calculation)
  if (/(^|[a-z])(ng|defect|reject|fail)[a-z]*count/.test(lower) || /^(ng|defect|reject)/.test(lower)) {
    const start = hasBase ? base : 0;
    return (t) => round(start + Math.floor(t / 30));
  }
  if (/count/.test(lower)) {
    const start = hasBase ? base : 0;
    return (t) => round(start + Math.floor(t / 3));
  }
  if (/cumulative|total|hours|energy/.test(lower)) {
    const start = hasBase ? base : 1000;
    return (t) => round(start + t * 0.01);
  }
  const center = hasBase ? base : 50;
  const swing = Math.abs(center) * 0.03 || 1;
  return (t) => round(center + Math.sin(t / 6) * swing);
}

/** Submodels that get tags by default — the same ones as the bundle linkage analysis */
export const SIMULATED_SUBMODELS = ['OperationalData'];

export function simulationPlan(environment: EnvironmentLike, submodels: readonly string[] = SIMULATED_SUBMODELS): SimMachine {
  const name = environment.assetAdministrationShells?.[0]?.idShort ?? 'Machine';
  const tags: SimTag[] = [];
  const used = new Map<string, number>();

  const walk = (elements: ElementLike[] | undefined, prefix: string): void => {
    for (const element of elements ?? []) {
      const idShort = element.idShort ?? '';
      const path = idShort ? `${prefix}/${idShort}` : prefix;
      if (element.modelType === 'Property' && idShort) {
        const dataType = dataTypeOf(element.valueType);
        // If the same name appears twice within the equipment, number the NodeId. The browse name stays unchanged
        const seen = used.get(idShort) ?? 0;
        used.set(idShort, seen + 1);
        tags.push({
          name: idShort,
          nodeId: `${name}.${idShort}${seen > 0 ? `_${seen + 1}` : ''}`,
          path,
          dataType,
          valueAt: valueRule(idShort, dataType, element.value),
        });
      }
      if (Array.isArray(element.value)) walk(element.value as ElementLike[], path);
      if (Array.isArray(element.statements)) walk(element.statements as ElementLike[], path);
    }
  };
  for (const submodel of environment.submodels ?? []) {
    if (submodels.includes(submodel.idShort ?? '')) walk(submodel.submodelElements, submodel.idShort ?? '');
  }
  return { name, tags };
}
