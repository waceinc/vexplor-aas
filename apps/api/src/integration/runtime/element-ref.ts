/**
 * The `source` element block of runtime events (docs/design/integration-v1.md §2.2): which AID interface and property
 * a value came from, at which (masked) address, and which model element it belongs to.
 *
 * The model element is found with the collector's own lookup (`findValuedElement`, the rule of the `?live=true`
 * overlay), so an event names exactly the element the live overlay writes — never a guess among several candidates.
 */
import type { Environment, KeyType, Reference } from '@aas/core';
import { findValuedElement, type AidInterface } from '@aas/collector';
import type { ElementSource } from '@aas/core';
import { maskCredentials } from '../ids.js';

/**
 * Endpoint path of the built-in virtual PLC — same value as @aas/opcua SIMULATOR_RESOURCE_PATH (and routes/evidence.ts):
 * @aas/opcua loads node-opcua and is imported lazily, so the constant cannot be imported here.
 */
export const VIRTUAL_PLC_PATH = '/UA/Simulator';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * True when the interface reads from the built-in virtual PLC (loopback host, path `/UA/Simulator`). Events and meter
 * readings from it carry `simulated: true`, so a CMMS never books a simulated run hour as a real one.
 */
export function isVirtualPlc(iface: Pick<AidInterface, 'base'>): boolean {
  if (!iface.base) return false;
  try {
    const url = new URL(iface.base.replace(/^[a-z][a-z0-9.+-]*:/i, 'http:'));
    return LOOPBACK.has(url.hostname) && url.pathname.replace(/\/+$/, '') === VIRTUAL_PLC_PATH;
  } catch {
    return false;
  }
}

/** First key value of a semanticId — the form events carry */
function semanticIdOf(element: { semanticId?: Reference }): string | null {
  return element.semanticId?.keys?.[0]?.value ?? null;
}

/**
 * Builds the `source` block. `address` is the property's read address (NodeId, register, topic) with credentials masked;
 * the model fields are null when the property does not resolve to exactly one valued element.
 */
export function elementSourceFor(
  environment: Environment,
  iface: AidInterface | undefined,
  interfaceName: string,
  propertyName: string,
  readAddress: string | undefined,
  simulated: boolean,
): ElementSource {
  const property = iface?.properties.find((candidate) => candidate.name === propertyName);
  const address = maskCredentials(readAddress ?? property?.href ?? '');
  const found = findValuedElement(environment, propertyName);
  if (found === undefined || found === 'ambiguous') {
    return { interfaceName, propertyName, address, submodelId: null, idShortPath: null, semanticId: null, observableReference: null, simulated };
  }
  const observableReference: Reference = {
    type: 'ModelReference',
    // One key per level (AAS Part 1 ModelReference): the submodel, then every element down to the property
    keys: [{ type: 'Submodel', value: found.submodelId }, ...found.steps.map((step) => ({ type: step.modelType as KeyType, value: step.value }))],
  };
  return {
    interfaceName,
    propertyName,
    address,
    submodelId: found.submodelId,
    idShortPath: found.idShortPath,
    semanticId: semanticIdOf(found.element as { semanticId?: Reference }),
    observableReference,
    simulated,
  };
}
