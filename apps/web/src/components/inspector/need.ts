/**
 * The "category" of the value table — per item: required · filled by collection · optional · unknown (2026-10-13).
 *
 * The concept comes from digital-twin production use — keep the whole template but light up only the "used items", so a first-time
 * user does not freeze in front of dozens of fields (digital-twin_AAS_참조분석_2026-10-13.md §2-2).
 * Important: do not make up what we do not know — with no template, or for items not in the template, it is "unknown" (neither required nor optional).
 */
import { normalizeElementPath } from '@aas/linter';
import type { SubmodelRequirement } from '../../api.js';

export type Need = 'required' | 'collected' | 'optional' | 'unknown';

/**
 * If a collection connection (AID) has the same name, "collection" wins — even if required, it is not a field a person fills.
 * (Same criterion as the rule for placing collected values on the model — names must match: collection/LiveMap)
 */
export function needOf(
  path: string,
  idShort: string,
  requirement: SubmodelRequirement | undefined,
  collectedNames: ReadonlySet<string> | undefined,
): Need {
  if (collectedNames?.has(idShort)) return 'collected';
  const element = requirement?.elements[normalizeElementPath(path)];
  if (!element) return 'unknown';
  return element.required ? 'required' : 'optional';
}
