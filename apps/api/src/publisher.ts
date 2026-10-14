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
import { AasOpcUaServer, planForPackage, type OpcUaSecurityOptions, type OpcUaTrustStore, type PublishPlan, type ServerStatus } from '@aas/opcua';
import type { AasStore } from '@aas/store';
import { verifyPassword } from './password.js';
import { LoginThrottle } from './session.js';

export interface PublisherOptions {
  store: AasStore;
  port?: number;
  /** Interval (ms) for re-reading the address space */
  refreshMs?: number;
  hostname?: string;
  /** How many values to scan per file — only the latest is used, so a generous number is fine */
  valueLimit?: number;
  /** OPC UA security (docs/design/integration-v1.md §7). server.ts sets it from OPCUA_ALLOW_INSECURE / OPCUA_PKI_DIR */
  security?: OpcUaSecurityOptions;
}

/**
 * The OPC UA user check for secure mode: the server's own accounts, any role (the address space is read-only),
 * disabled accounts refused, guessing slowed by the same `LoginThrottle` the web login uses.
 * Important: node-opcua does not hand the client address to the check, so the throttle's address slot is the fixed
 *    word 'opcua': five failures block the account on OPC UA for a while, and the account-wide cap still stops guessing.
 *    Pass the web login's throttle to make OPC UA failures count towards the same account-wide cap.
 */
export function accountVerifier(
  store: Pick<AasStore, 'findUserByLogin'>,
  throttle: LoginThrottle = new LoginThrottle(),
): (username: string, password: string) => Promise<boolean> {
  return async (username, password) => {
    const login = username.trim();
    if (login === '' || throttle.blocked(login, 'opcua')) return false;
    const user = await store.findUserByLogin(login);
    const ok = user !== undefined && !user.disabled && (await verifyPassword(password, user.passwordHash));
    if (ok) throttle.pass(login, 'opcua');
    else throttle.fail(login, 'opcua');
    return ok;
  };
}

export class OpcUaPublisher {
  private readonly server: AasOpcUaServer;

  constructor(private readonly options: PublisherOptions) {
    this.server = new AasOpcUaServer({
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      refreshMs: options.refreshMs ?? 5000,
      load: () => this.plans(),
      ...(options.security ? { security: options.security } : {}),
    });
  }

  /** Client certificate trust store — undefined unless the server runs in secure mode (routes-opcua.ts) */
  pki(): OpcUaTrustStore | undefined {
    return this.server.pki();
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
