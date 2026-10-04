/**
 * OPC UA 노출 감독 — 기획서 M6·M7을 저장소에 붙이는 자리.
 *
 * 하는 일은 하나다: **저장소에 있는 것을 노드 계획으로 바꿔 서버에 넘긴다.**
 *
 * 🔴 값은 시계열에서 읽어 `overlayEnvironment`로 덧씌운다 — Part 2의 `?live=true`와
 *    **같은 함수**다. 두 곳에서 따로 값을 고르면 REST와 OPC UA가 서로 다른 값을 말하게 된다.
 *    (BaSyx DataBridge가 겪는 문제를 그대로 물려받을 이유가 없다)
 * 🔴 모델에는 되쓰지 않는다. 덧씌우기는 사본에만 한다 — 값 동기화 A안.
 */
import { overlayEnvironment, type ValueSample } from '@aas/collector';
import { AasOpcUaServer, planForPackage, type PublishPlan, type ServerStatus } from '@aas/opcua';
import type { AasStore } from '@aas/store';

export interface PublisherOptions {
  store: AasStore;
  port?: number;
  /** 주소공간을 다시 읽는 주기(ms) */
  refreshMs?: number;
  hostname?: string;
  /** 한 파일에서 값을 몇 개까지 훑을지 — 최신값만 쓰므로 넉넉하면 된다 */
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

  /** 지금 곧바로 맞춘다 — 수동 수집 직후처럼 기다릴 이유가 없을 때 */
  refresh(): Promise<void> {
    return this.server.refresh();
  }

  /** 저장소 전체 → 노드 계획들 */
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
          // 수집값이 얹힌 **사본**으로 계획을 세운다
          const { content } = overlayEnvironment(environment, samples);
          out.push(planForPackage(content, { packageId: record.id, name: record.name }));
        } catch {
          // 🔴 파일 하나가 깨져도 나머지는 계속 내준다 — 서버 전체를 떨구지 않는다
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return out;
  }
}
