/**
 * The S7 and MC part of the AID builder (aid-build.ts) — VEXPLOR extension bindings (plc-address.ts).
 * Split out so the builder stays within its size; the grammar itself lives in plc-address.ts, shared with the readers.
 */
import { fill, tr } from '@aas/core';
import { AidBuildError, ref } from './aid-build-parts.js';
import { BINDING_IRI, mcAddress, mcEndpoint, s7Address, s7Endpoint } from './plc-address.js';

/** Endpoint check now, then a per-tag address check — both report as AidBuildError (400), never as a 500 */
export function plcHrefCheck(protocol: 'S7' | 'MC', endpoint: string): (name: string, href: string) => void {
  try {
    const series = protocol === 'MC' ? mcEndpoint(endpoint).series : (s7Endpoint(endpoint), undefined);
    return (name, href) => {
      try {
        if (protocol === 'S7') s7Address(href);
        else mcAddress(href, series);
      } catch (error) {
        throw new AidBuildError(fill(tr('태그 {0}: {1}'), { 0: name, 1: error instanceof Error ? error.message : String(error) }));
      }
    };
  } catch (error) {
    if (error instanceof AidBuildError) throw error;
    throw new AidBuildError(error instanceof Error ? error.message : String(error));
  }
}

/** S7 · MC interfaces also state our binding IRI — the protocol is then read by term, not guessed from the scheme */
export function withBinding<T extends { supplementalSemanticIds: unknown[] }>(protocol: string, node: T): T {
  if (protocol !== 'S7' && protocol !== 'MC') return node;
  return { ...node, supplementalSemanticIds: [...node.supplementalSemanticIds, ref(BINDING_IRI[protocol])] };
}
