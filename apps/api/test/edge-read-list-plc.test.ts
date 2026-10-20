/**
 * S7, MC and XGT on the edge read list (docs/edge-contract.md §4) — the VEXPLOR extension bindings reach a remote collector.
 *
 * Important: an older edge that does not know S7, MC or XGT skips such an interface and reports it in `status` (§4), so the
 *    read list may name them without a new contract version. The list must still carry exactly what the AID states:
 *    the endpoint as `base`, the address as `href`, the read period, and no login — S7, MC and XGT have none.
 */
import { buildAidSubmodel } from '@aas/collector';
import { describe, expect, it } from 'vitest';
import { EDGE_SCHEMAS } from '../src/edge/schemas.js';
import { aidReadList } from '../src/integration/bundle-build.js';
import { checkSchema } from '../src/integration/schema-check.js';

const iriBase = 'https://example.com/ids';

function environment() {
  return {
    submodels: [
      buildAidSubmodel({
        assetName: 'Press1',
        iriBase,
        endpoint: 's7://192.168.0.10?rack=0&slot=1',
        tags: [
          { name: 'Speed', href: 'DB10.DBD4:REAL', type: 'float', unit: 'rpm' },
          { name: 'Running', href: 'M10.3', type: 'boolean' },
        ],
        intervalMs: 500,
      }),
      buildAidSubmodel({
        assetName: 'Press2',
        iriBase,
        endpoint: 'melsec://192.168.0.11:5000?series=iQ-F',
        tags: [
          { name: 'Count', href: 'D100:DINT', type: 'integer' },
          { name: 'Input', href: 'X17', type: 'boolean' },
        ],
      }),
      buildAidSubmodel({
        assetName: 'Press3',
        iriBase,
        endpoint: 'xgt://192.168.0.12:2004?series=XGI',
        tags: [
          { name: 'Count', href: '%MD10:DINT', type: 'integer' },
          { name: 'Input', href: '%IX0.0.3', type: 'boolean' },
        ],
        intervalMs: 2000,
      }),
    ],
  } as never;
}

describe('edge read list — S7, MC and XGT', () => {
  it('lists S7, MC and XGT interfaces with their endpoint, addresses, read period and no login', () => {
    const list = aidReadList(environment(), 'pkg_1', 1000);
    const s7 = list.find((iface) => iface.protocol === 'S7');
    const mc = list.find((iface) => iface.protocol === 'MC');
    expect(s7).toMatchObject({ interfaceName: 'InterfaceTemplateForS7', endpoint: 's7://192.168.0.10?rack=0&slot=1', security: { mode: 'None' }, intervalMs: 500 });
    expect(s7!.tags.map((tag) => [tag.propertyName, tag.address, tag.type])).toEqual([
      ['Speed', 'DB10.DBD4:REAL', 'float'],
      ['Running', 'M10.3', 'boolean'],
    ]);
    expect(mc).toMatchObject({ interfaceName: 'InterfaceTemplateForMC', endpoint: 'melsec://192.168.0.11:5000?series=iQ-F', security: { mode: 'None' }, intervalMs: 1000 });
    expect(mc!.tags.map((tag) => tag.address)).toEqual(['D100:DINT', 'X17']);
    const xgt = list.find((iface) => iface.protocol === 'XGT');
    expect(xgt).toMatchObject({ interfaceName: 'InterfaceTemplateForXGT', endpoint: 'xgt://192.168.0.12:2004?series=XGI', security: { mode: 'None' }, intervalMs: 2000 });
    expect(xgt!.tags.map((tag) => tag.address)).toEqual(['%MD10:DINT', '%IX0.0.3']);
    for (const iface of [s7!, mc!, xgt!]) expect(iface.security.credentialRef).toBeUndefined();
  });

  it('the read list naming them passes the published read-list schema', () => {
    const body = { schema: 'vexplor.edge.readList/1', deviceId: 'dev_1', revision: 'r1', state: 'approved', approvedAt: '2026-10-20T00:00:00.000Z', pollSeconds: 60, interfaces: aidReadList(environment(), 'pkg_1', 1000) };
    expect(body.interfaces.map((iface) => iface.protocol)).toEqual(['S7', 'MC', 'XGT']);
    expect(checkSchema(EDGE_SCHEMAS['read-list']!, body)).toEqual([]);
    expect(checkSchema(EDGE_SCHEMAS['read-list']!, { ...body, interfaces: [{ ...body.interfaces[0]!, protocol: 'PROFINET' }] })).not.toEqual([]);
  });
});
