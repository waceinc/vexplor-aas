/**
 * The S7, MC and XGT part of the AID builder (aid-build.ts) — VEXPLOR extension bindings (plc-address.ts · xgt-address.ts).
 * Split out so the builder stays within its size; the grammar itself lives in those files, shared with the readers.
 */
import { fill, tr } from '@aas/core';
import { AidBuildError, ref } from './aid-build-parts.js';
import { BINDING_IRI, mcAddress, mcEndpoint, s7Address, s7Endpoint } from './plc-address.js';
import { xgtAddress, xgtEndpoint } from './xgt-address.js';

/** Endpoint check now, then a per-tag address check — both report as AidBuildError (400), never as a 500 */
export function plcHrefCheck(protocol: 'S7' | 'MC' | 'XGT', endpoint: string): (name: string, href: string) => void {
  try {
    const check: (href: string) => unknown =
      protocol === 'MC'
        ? ((series) => (href: string) => mcAddress(href, series))(mcEndpoint(endpoint).series)
        : protocol === 'XGT'
          ? ((series) => (href: string) => xgtAddress(href, series))(xgtEndpoint(endpoint).series)
          : (s7Endpoint(endpoint), s7Address);
    return (name, href) => {
      try {
        check(href);
      } catch (error) {
        throw new AidBuildError(fill(tr('태그 {0}: {1}'), { 0: name, 1: error instanceof Error ? error.message : String(error) }));
      }
    };
  } catch (error) {
    if (error instanceof AidBuildError) throw error;
    throw new AidBuildError(error instanceof Error ? error.message : String(error));
  }
}

/** S7 · MC · XGT interfaces also state our binding IRI — the protocol is then read by term, not guessed from the scheme */
export function withBinding<T extends { supplementalSemanticIds: unknown[] }>(protocol: string, node: T): T {
  if (protocol !== 'S7' && protocol !== 'MC' && protocol !== 'XGT') return node;
  return { ...node, supplementalSemanticIds: [...node.supplementalSemanticIds, ref(BINDING_IRI[protocol])] };
}
