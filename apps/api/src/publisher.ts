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
import { AasOpcUaServer, planForPackage, type OpcUaClientInfo, type OpcUaSecurityOptions, type OpcUaTrustStore, type PublishPlan, type ServerStatus } from '@aas/opcua';
import type { AasStore } from '@aas/store';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';
import { LoginThrottle } from './session.js';

export interface PublisherOptions {
  store: AasStore;
  port?: number;
  /** Interval (ms) for re-reading the address space */
  refreshMs?: number;
  hostname?: string;
  /** How many values to scan per file — only the latest is used, so a generous number is fine */
  valueLimit?: number;
  /**
   * OPC UA security (docs/design/integration-v1.md §7). server.ts sets it from OPCUA_ALLOW_INSECURE / OPCUA_PKI_DIR.
   * Absent = secure, which needs `verifyUser` — the server refuses to start rather than open an unauthenticated port
   */
  security?: OpcUaSecurityOptions;
}

/** A hash nobody's password matches — checked for unknown logins so the answer takes as long as for real ones */
let dummyHash: Promise<string> | undefined;

/** The throttle slot of one OPC UA client: its certificate, else its address, else one shared slot */
function clientSlot(client: OpcUaClientInfo | undefined): string {
  if (client?.certificateThumbprint) return `opcua-cert:${client.certificateThumbprint}`;
  if (client?.address) return `opcua-addr:${client.address}`;
  return 'opcua';
}

/**
 * The OPC UA user check for secure mode: the server's own accounts, any role (the address space is read-only),
 * disabled accounts refused, guessing slowed by the same `LoginThrottle` the web login uses.
 * Important: the throttle counts per account **and client** (certificate thumbprint, else peer address — review L5).
 *    With one shared slot, five wrong passwords from anyone would lock the account for every MES. The throttle's
 *    account-wide cap still stops guessing from many clients. Pass the web login's throttle to share that cap.
 * Important: an unknown login still runs a full password check against a dummy hash, so the response time does not
 *    tell which logins exist.
 */
export function accountVerifier(
  store: Pick<AasStore, 'findUserByLogin'>,
  throttle: LoginThrottle = new LoginThrottle(),
): (username: string, password: string, client?: OpcUaClientInfo) => Promise<boolean> {
  return async (username, password, client) => {
    const login = username.trim();
    const slot = clientSlot(client);
    if (login === '' || throttle.blocked(login, slot)) return false;
    const user = await store.findUserByLogin(login);
    const matches = await verifyPassword(password, user?.passwordHash ?? (await (dummyHash ??= hashPassword(randomBytes(24).toString('base64')))));
    const ok = user !== undefined && !user.disabled && matches;
    if (ok) throttle.pass(login, slot);
    else throttle.fail(login, slot);
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
