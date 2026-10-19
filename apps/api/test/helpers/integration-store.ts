/**
 * Store for WP4 tests: `InMemoryStore` plus the integration port.
 *
 * Until WP1 merges, `InMemoryStore` has no integration methods and records no model events. This double composes the
 * WP0 reference log (`MemoryIntegrationLog`, the same class WP1 composes) and records one model event per mutating
 * call, with the shapes of design §2.3. Once `InMemoryStore` itself implements the port, `createIntegrationStore`
 * returns it unchanged — the tests then run against the real store without edits.
 */
import { randomUUID } from 'node:crypto';
import type { AasxPackage } from '@aas/aasx';
import {
  actorFields,
  changeFields,
  InMemoryStore,
  MemoryIntegrationLog,
  type AasStore,
  type CreateOptions,
  type IdentifiableModelType,
  type IdentifiableRecord,
  type IntegrationStore,
  type PackageFileRecord,
  type ImportPackageInput,
  type PackageRecord,
  type WriteOptions,
} from '@aas/store';

export type IntegrationTestStore = AasStore & IntegrationStore;

const TYPE_NAMES: Record<IdentifiableModelType, string> = {
  AssetAdministrationShell: 'shell',
  Submodel: 'submodel',
  ConceptDescription: 'conceptdescription',
};

const INTEGRATION_METHODS = [
  'appendEvents', 'readEvents', 'pruneEvents', 'listSubscriptions', 'getSubscription', 'createSubscription',
  'updateSubscription', 'deleteSubscription', 'enqueueDeliveries', 'claimDeliveries', 'completeDelivery', 'getDelivery',
  'listDeliveries', 'redeliver', 'deliveryStats', 'pruneDeliveries', 'getServerIntegrationConfig',
  'putServerIntegrationConfig', 'getPackageIntegrationConfig', 'putPackageIntegrationConfig', 'getExternalRefs',
  'putExternalRefs', 'findExternalRef', 'listExternalRefs', 'getRuntimeState', 'putRuntimeState',
] as const;

// Declaration merging: the constructor copies the log's methods onto the instance
interface EventedMemoryStore extends IntegrationStore {}

class EventedMemoryStore extends InMemoryStore {
  readonly log: MemoryIntegrationLog;
  private readonly owners = new Map<string, string | undefined>();

  constructor(now?: () => string) {
    super(now);
    this.log = new MemoryIntegrationLog((packageId) => (this.owners.has(packageId) ? this.owners.get(packageId) : null), now ? { now } : {});
    for (const name of INTEGRATION_METHODS) {
      const method = (this.log as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
      (this as unknown as Record<string, unknown>)[name] = method.bind(this.log);
    }
  }

  private async record(packageId: string, type: string, data: Record<string, unknown>): Promise<void> {
    const pkg = await super.getPackage(packageId);
    const shell = pkg ? (await super.listIdentifiables(packageId, 'AssetAdministrationShell')).items[0] : undefined;
    const info = (shell?.content['assetInformation'] ?? {}) as { globalAssetId?: string };
    this.log.recordModelEvent({
      id: randomUUID(),
      type: `kr.vexplor.aas.model.${type}.v1`,
      time: new Date().toISOString(),
      packageId,
      ...(pkg ? { packageRevision: pkg.revision } : {}),
      ...(this.owners.get(packageId) !== undefined ? { owner: this.owners.get(packageId)! } : {}),
      ...actorFields(),
      ...changeFields(),
      data: { packageId, globalAssetId: info.globalAssetId ?? null, aasId: shell?.id ?? null, ...data },
    });
  }

  override async importPackage(input: ImportPackageInput): Promise<PackageRecord> {
    const record = await super.importPackage(input);
    this.owners.set(record.id, record.owner);
    await this.record(record.id, 'package.created', { name: record.name, owner: record.owner ?? null });
    return record;
  }

  override async deletePackage(packageId: string): Promise<void> {
    const pkg = await super.getPackage(packageId);
    const shell = pkg ? (await super.listIdentifiables(packageId, 'AssetAdministrationShell')).items[0] : undefined;
    await super.deletePackage(packageId);
    const owner = this.owners.get(packageId);
    this.owners.delete(packageId);
    this.log.forgetPackage(packageId);
    this.log.recordModelEvent({
      id: randomUUID(),
      type: 'kr.vexplor.aas.model.package.deleted.v1',
      time: new Date().toISOString(),
      packageId,
      ...(owner !== undefined ? { owner } : {}),
      ...actorFields(),
      ...changeFields(),
      data: {
        packageId,
        name: pkg?.name ?? '',
        globalAssetId: (shell?.content['assetInformation'] as { globalAssetId?: string } | undefined)?.globalAssetId ?? null,
        aasId: shell?.id ?? null,
      },
    });
  }

  override async putPackageFile(packageId: string, file: PackageFileRecord): Promise<void> {
    await super.putPackageFile(packageId, file);
    await this.record(packageId, 'package.file.changed', { part: file.part, role: file.role, operation: 'put' });
  }

  override async deletePackageFile(packageId: string, part: string): Promise<void> {
    await super.deletePackageFile(packageId, part);
    await this.record(packageId, 'package.file.changed', { part, role: 'supplementary', operation: 'delete' });
  }

  override async createIdentifiable(packageId: string, content: Record<string, unknown>, options?: CreateOptions): Promise<IdentifiableRecord> {
    const created = await super.createIdentifiable(packageId, content, options);
    await this.record(packageId, `${TYPE_NAMES[created.modelType]}.created`, { modelType: created.modelType, id: created.id, operation: 'create' });
    return created;
  }

  override async updateIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    content: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<IdentifiableRecord> {
    const updated = await super.updateIdentifiable(packageId, modelType, id, content, options);
    await this.record(packageId, `${TYPE_NAMES[modelType]}.updated`, { modelType, id, operation: 'update' });
    return updated;
  }

  override async deleteIdentifiable(packageId: string, modelType: IdentifiableModelType, id: string, options?: WriteOptions): Promise<void> {
    await super.deleteIdentifiable(packageId, modelType, id, options);
    await this.record(packageId, `${TYPE_NAMES[modelType]}.deleted`, { modelType, id, operation: 'delete' });
  }
}

export function createIntegrationStore(now?: () => string): IntegrationTestStore {
  const plain = new InMemoryStore(now);
  // After WP1: the real store already implements the port and records model events itself
  if (typeof (plain as unknown as Partial<IntegrationStore>).appendEvents === 'function') return plain as unknown as IntegrationTestStore;
  return new EventedMemoryStore(now);
}
