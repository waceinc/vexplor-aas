/**
 * Units of measure for exported values (docs/design/integration-v1.md §4.4, ERP E-11).
 *
 * The unit comes from the element's ConceptDescription (IEC 61360 `unit`), never from the column name and never from a
 * definition text such as "전체 중량(kg)" — reading a unit out of prose is guessing. No unit in the CD → null, and the
 * caller lists the key in `missing`.
 */
import type { Environment } from '@aas/core';
import { asArray, asRecord, semanticIdOf, type Json } from './elements.js';

/** IEC 61360 `unit` of the ConceptDescription the element's semanticId points at; null when there is none */
export function unitOf(environment: Environment, element: Json | undefined): string | null {
  if (!element) return null;
  const semanticId = semanticIdOf(element);
  if (!semanticId) return null;
  const concept = asArray(environment.conceptDescriptions as unknown).find((cd) => cd['id'] === semanticId);
  if (!concept) return null;
  for (const specification of asArray(concept['embeddedDataSpecifications'])) {
    const content = asRecord(specification['dataSpecificationContent']);
    const unit = content?.['unit'];
    if (typeof unit === 'string' && unit.trim() !== '') return unit.trim();
  }
  return null;
}
