/**
 * Test doubles and scenario builders for the integration runtime (WP2).
 *
 * `runtimeStore()` is an `InMemoryStore` with the integration port attached. Until the store work package merges the
 * port into `InMemoryStore` itself, the integration methods are served by a `MemoryIntegrationLog` (the reference
 * implementation the store composes anyway); once `InMemoryStore` has them, the proxy simply passes through.
 *
 * The scenario builders produce real detector events for the schema test of the delivery work package
 * (`integration-schemas.test.ts` imports them from here).
 */
import type { AidInterface, CycleReport, ValueSample } from '@aas/collector';
import { defaultServerIntegrationConfig, type AssetJoin, type Environment, type ServerIntegrationConfig } from '@aas/core';
import { InMemoryStore, MemoryIntegrationLog, type AasStore, type IntegrationStore, type PackageRecord, type StoredEvent } from '@aas/store';
import { EquipmentDetector } from '../../src/integration/runtime/detector.js';
import type { PackageCycle } from '../../src/supervisor.js';

export type RuntimeStore = AasStore & IntegrationStore;

export async function runtimeStore(): Promise<RuntimeStore> {
  const base = new InMemoryStore();
  await base.init();
  const owners = new Map<string, string | undefined>();
  const log = new MemoryIntegrationLog((id) => (owners.has(id) ? owners.get(id) : null));
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'importPackage') {
        return async (...args: Parameters<AasStore['importPackage']>) => {
          const record = await target.importPackage(...args);
          owners.set(record.id, record.owner);
          return record;
        };
      }
      if (prop === 'deletePackage') {
        return async (id: string) => {
          await target.deletePackage(id);
          owners.delete(id);
          log.forgetPackage(id);
        };
      }
      if (!(prop in target) && prop in log) {
        const member = (log as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof member === 'function' ? member.bind(log) : member;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as RuntimeStore;
}

export function joinBlock(packageId: string, globalAssetId: string | null = 'https://example.com/ids/asset/press-03'): AssetJoin {
  return {
    globalAssetId,
    aasId: globalAssetId === null ? null : 'https://example.com/ids/aas/press-03',
    packageId,
    assetKind: 'Instance',
    serialNumber: null,
    specificAssetIds: [],
    externalRefs: [],
    path: [],
    isa95: null,
  };
}

/** One AID interface with the given property names, reading from `base` */
export function iface(name: string, properties: readonly string[], base = 'opc.tcp://10.0.0.5:4840'): AidInterface {
  return {
    name,
    protocol: 'OPCUA',
    base,
    properties: properties.map((property) => ({ name: property, href: `ns=1;s=Machine.${property}`, observable: true, formFields: {} })),
  };
}

/** A small model with one submodel holding the given properties — lets the `source` block resolve to elements */
export function environmentWith(properties: readonly string[]): Environment {
  return {
    assetAdministrationShells: [
      { modelType: 'AssetAdministrationShell', id: 'https://example.com/ids/aas/press-03', idShort: 'Press', assetInformation: { assetKind: 'Instance', globalAssetId: 'https://example.com/ids/asset/press-03' } },
    ],
    submodels: [
      {
        modelType: 'Submodel',
        id: 'https://example.com/ids/sm/OperationalData',
        idShort: 'OperationalData',
        submodelElements: properties.map((idShort) => ({
          modelType: 'Property',
          idShort,
          valueType: 'xs:string',
          semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: `https://example.com/ids/cd/${idShort}` }] },
        })),
      },
    ],
  } as unknown as Environment;
}

export type SampleValue = number | string | { value: number | string; quality: string };

/**
 * Builds cycles at a fixed rhythm. `cycle(values)` makes one PackageCycle at the next tick with one sample per given
 * property (all from interface `PLC1`), `failed` marks interfaces whose connection failed in that cycle.
 */
export class CycleClock {
  private tick = 0;
  constructor(
    readonly record: PackageRecord,
    readonly environment: Environment,
    readonly interfaces: readonly AidInterface[],
    readonly intervalMs = 1000,
    readonly startMs = Date.parse('2026-10-14T00:00:00.000Z'),
  ) {}

  at(tick: number): string {
    return new Date(this.startMs + tick * this.intervalMs).toISOString();
  }

  cycle(values: Record<string, SampleValue>, failed: readonly string[] = []): PackageCycle {
    const time = this.at(this.tick);
    this.tick += 1;
    const samples: ValueSample[] = Object.entries(values).map(([propertyName, raw]) => {
      const { value, quality } = typeof raw === 'object' ? raw : { value: raw, quality: 'Good' };
      const owner = this.interfaces.find((candidate) => candidate.properties.some((p) => p.name === propertyName));
      return {
        packageId: this.record.id,
        interfaceName: owner?.name ?? 'PLC1',
        propertyName,
        source: `ns=1;s=Machine.${propertyName}`,
        observedAt: time,
        receivedAt: time,
        ...(typeof value === 'number' ? { valueNumber: value, valueText: String(value) } : { valueText: value }),
        quality,
      };
    });
    const report: CycleReport = {
      startedAt: time,
      collected: samples.length,
      interfaces: this.interfaces.map((candidate) => (failed.includes(candidate.name) ? { name: candidate.name, error: 'connect ECONNREFUSED' } : { name: candidate.name })),
    };
    return { record: this.record, environment: this.environment, interfaces: this.interfaces, cycle: report, samples, startedAt: time, finishedAt: time, intervalMs: this.intervalMs };
  }
}

export async function seededPackage(store: RuntimeStore): Promise<PackageRecord> {
  const { readAasx } = await import('@aas/aasx');
  const { readFileSync } = await import('node:fs');
  return store.importPackage({ name: 'press.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))) });
}

export function detectorFor(store: RuntimeStore, server: ServerIntegrationConfig = defaultServerIntegrationConfig('9f2c4e1a7b3d'), globalAssetId?: string | null): EquipmentDetector {
  return new EquipmentDetector({
    store,
    join: async (packageId) => ((await store.getPackage(packageId)) ? joinBlock(packageId, globalAssetId === undefined ? 'https://example.com/ids/asset/press-03' : globalAssetId) : null),
    serverConfig: async () => server,
  });
}

/**
 * Scenario: one of every runtime event type the detector emits (state changed, alarm raised and cleared, threshold
 * crossed and returned, counter advanced, connection lost and restored). For schema validation in WP3.
 */
export async function runtimeEventScenario(): Promise<StoredEvent[]> {
  const store = await runtimeStore();
  const record = await seededPackage(store);
  await store.putPackageIntegrationConfig(record.id, {
    schema: 'vexplor.packageIntegrationConfig/1',
    state: { property: 'MachineState', interfaceName: null, rules: null },
    alarms: [{ id: 'alarm-main', property: 'AlarmActive', codeProperty: 'AlarmCode' }],
    counters: [{ id: 'produced', property: 'ProductionCount', kind: 'total' }],
    thresholds: [{ id: 'temp-high', property: 'MotorTemperature', direction: 'above', limit: 85, hysteresis: 2, unit: 'degC' }],
  });
  const properties = ['MachineState', 'AlarmActive', 'AlarmCode', 'ProductionCount', 'MotorTemperature'];
  const clock = new CycleClock(record, environmentWith(properties), [iface('PLC1', properties)]);
  const detector = detectorFor(store);
  const steps: [Record<string, SampleValue>, string[]][] = [
    [{ MachineState: 'run', AlarmActive: 0, AlarmCode: '', ProductionCount: 100, MotorTemperature: 70 }, []],
    [{ MachineState: 'alarm', AlarmActive: 1, AlarmCode: 'E-217', ProductionCount: 105, MotorTemperature: 90 }, []],
    [{ MachineState: 'run', AlarmActive: 0, AlarmCode: '', ProductionCount: 110, MotorTemperature: 70 }, []],
    [{}, ['PLC1']],
    [{}, ['PLC1']],
    [{ MachineState: 'run' }, []],
  ];
  const events: StoredEvent[] = [];
  for (const [values, failed] of steps) events.push(...(await detector.onPackageCycle(clock.cycle(values, failed))));
  return events;
}
