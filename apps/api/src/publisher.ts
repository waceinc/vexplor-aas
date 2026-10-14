/**
 * OPC UA exposure supervisor — where plan items M6/M7 attach to the store.
 *
 * It does one thing: **turn what is in the store into node plans and hand them to the server.**
 *
 * Important: values are read from the time series and overlaid via `overlayEnvironment` — the **same function** as
 *    Part 2's `?live=true`. If two places picked values separately, REST and OPC UA would report different values.
 *    (There is no reason to inherit the problem BaSyx DataBridge has)
 * Important: never written back to the model. Overlays are applied only to a copy — value sync option A.
 */
import { overlayEnvironment, type ValueSample } from '@aas/collector';
import { AasOpcUaServer, planForPackage, type PublishPlan, type ServerStatus } from '@aas/opcua';
import type { AasStore } from '@aas/store';

export interface PublisherOptions {
  store: AasStore;
  port?: number;
  /** Interval (ms) for re-reading the address space */
  refreshMs?: number;
  hostname?: string;
  /** How many values to scan per file — only the latest is used, so a generous number is fine */
  valueLimit?: number;
}

export class OpcUaPublisher {
  private readonly server: AasOpcUaServer;

  constructor(private readonly options: PublisherOptions) {
    this.server = new AasOpcUaServer({
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      refreshMs: options.refreshMs ?? 5000,
      load: () => this.plans(),
    });
  }

  start(): Promise<void> {
    return this.server.start();
  }

  stop(): Promise<void> {
    return this.server.stop();
  }

  status(): ServerStatus {
    return this.server.currentStatus();
  }

  /** Sync right now — when there is no reason to wait, e.g. right after a manual collection */
  refresh(): Promise<void> {
    return this.server.refresh();
  }

  /** Whole store → node plans */
  private async plans(): Promise<PublishPlan[]> {
    const out: PublishPlan[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.store.listPackages(cursor === undefined ? {} : { cursor });
      for (const record of page.items) {
        try {
          const environment = await this.options.store.getEnvironment(record.id);
          const samples = (await this.options.store.readValues(record.id, {
            limit: this.options.valueLimit ?? 2000,
          })) as unknown as ValueSample[];
          // Build the plan from a **copy** with collected values overlaid
          const { content } = overlayEnvironment(environment, samples);
          out.push(planForPackage(content, { packageId: record.id, name: record.name }));
        } catch {
          // Important: keep serving the rest even if one file is broken — do not take down the whole server
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return out;
  }
}
