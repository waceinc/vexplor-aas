/**
 * M6·M7 전 과정 — **우리 도구가 OPC UA 서버가 된다**.
 *
 * 기획서 Ⅲ-3의 그림을 그대로 시험한다:
 *   수집값 ──▶ 우리 서버 ──subscribe──▶ 상위 앱
 *
 * 🔴 이 시험의 핵심은 읽기가 아니라 **구독**이다. 읽기만 되면 Part 2 REST로 충분하고,
 *    OPC UA 서버를 세울 이유가 없다. 값이 바뀔 때 **서버가 먼저 알려 주는지**가 관건이다.
 * 🔴 그리고 **쓰기가 막히는지** — 값 동기화 A안을 프로토콜 수준에서 지키는지 본다.
 */
import type { Environment } from '@aas/core';
import {
  AttributeIds,
  ClientMonitoredItem,
  DataType,
  OPCUAClient,
  StatusCodes,
  TimestampsToReturn,
  Variant,
  type ClientSession,
} from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AasOpcUaServer, planForPackage, type PublishPlan } from '../src/index.js';

const PID = 'pkg-1';

/** 설비 한 벌 — 정적 제원 하나 + 현장에서 바뀌는 값 하나 */
function environmentWith(speed: string | undefined): Environment {
  return {
    assetAdministrationShells: [
      {
        modelType: 'AssetAdministrationShell',
        id: 'aas-1',
        idShort: '롤포밍기',
        assetInformation: { assetKind: 'Type' },
      },
    ],
    submodels: [
      {
        modelType: 'Submodel',
        id: 'https://ktl/sm/tech',
        idShort: 'TechnicalData',
        submodelElements: [
          { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: '한국기계' },
          {
            modelType: 'Property',
            idShort: 'MotorSpeed',
            valueType: 'xs:double',
            ...(speed === undefined ? {} : { value: speed }),
          },
          { modelType: 'Property', idShort: 'NotCollectedYet', valueType: 'xs:double' },
        ],
      },
    ],
  } as unknown as Environment;
}

let server: AasOpcUaServer;
let endpoint: string;
let client: OPCUAClient;
let session: ClientSession;
/** 수집기가 값을 바꾸는 것을 흉내 낸다 */
let speed: string | undefined = '1200.5';

const SPEED_NODE = `ns=1;s=${PID}/https://ktl/sm/tech/MotorSpeed`;

async function startOn(port: number): Promise<void> {
  server = new AasOpcUaServer({
    port,
    hostname: '127.0.0.1',
    load: async (): Promise<PublishPlan[]> => [
      planForPackage(environmentWith(speed), { packageId: PID, name: '롤포밍기' }),
    ],
  });
  await server.start();
  endpoint = `opc.tcp://127.0.0.1:${port}/UA/AAS`;
}

beforeAll(async () => {
  try {
    await startOn(14870);
  } catch {
    await startOn(14871);
  }
  client = OPCUAClient.create({ endpointMustExist: false });
  await client.connect(endpoint);
  session = await client.createSession();
}, 60_000);

afterAll(async () => {
  await session?.close().catch(() => undefined);
  await client?.disconnect().catch(() => undefined);
  await server?.stop();
});

describe('AAS를 OPC UA로 내주기', () => {
  it('서버가 서고 상태를 말한다', () => {
    const status = server.currentStatus();
    expect(status.running).toBe(true);
    expect(status.packages).toBe(1);
    expect(status.variables).toBe(3);
  });

  it('AAS 계층이 그대로 브라우징된다 — AAS > 설비 > 서브모델 > 항목', async () => {
    // 상위 앱이 실제로 하는 일이 이것이다: 주소를 몰라도 훑어서 찾는다
    const names = async (nodeId: string): Promise<string[]> =>
      (await session.browse(nodeId)).references?.map((ref) => ref.browseName.name ?? '') ?? [];

    expect(await names('ns=1;s=AAS')).toContain('롤포밍기');
    expect(await names(`ns=1;s=${PID}`)).toContain('TechnicalData');
    expect(await names(`ns=1;s=${PID}/https://ktl/sm/tech`)).toEqual(
      expect.arrayContaining(['ManufacturerName', 'MotorSpeed', 'NotCollectedYet']),
    );
  });

  it('정적 제원(모델에 적힌 값)을 읽는다', async () => {
    const read = await session.read({
      nodeId: `ns=1;s=${PID}/https://ktl/sm/tech/ManufacturerName`,
      attributeId: AttributeIds.Value,
    });
    expect(read.statusCode).toBe(StatusCodes.Good);
    expect(read.value.value).toBe('한국기계');
  });

  it('수집값을 자료형 그대로 읽는다 — 문자열이 아니라 Double', async () => {
    const read = await session.read({ nodeId: SPEED_NODE, attributeId: AttributeIds.Value });
    expect(read.statusCode).toBe(StatusCodes.Good);
    expect(read.value.dataType).toBe(DataType.Double);
    expect(read.value.value).toBeCloseTo(1200.5);
  });

  it('🔴 아직 안 들어온 값은 "없음"이라고 말한다 — 0으로 지어내지 않는다', async () => {
    const read = await session.read({
      nodeId: `ns=1;s=${PID}/https://ktl/sm/tech/NotCollectedYet`,
      attributeId: AttributeIds.Value,
    });
    expect(read.statusCode).toBe(StatusCodes.BadWaitingForInitialData);
  });

  it('🔴 쓰기가 막힌다 — 값 동기화 A안(파일이 원본)을 프로토콜에서 지킨다', async () => {
    const status = await session.write({
      nodeId: SPEED_NODE,
      attributeId: AttributeIds.Value,
      value: { value: new Variant({ dataType: DataType.Double, value: 9999 }) },
    });
    expect(status).not.toBe(StatusCodes.Good);
    // 막혔으니 값도 그대로여야 한다
    const read = await session.read({ nodeId: SPEED_NODE, attributeId: AttributeIds.Value });
    expect(read.value.value).toBeCloseTo(1200.5);
  });

  it('🔴 값이 바뀌면 구독자에게 밀려 온다 — 이것이 REST로 못 하는 일이다', async () => {
    const subscription = await session.createSubscription2({
      requestedPublishingInterval: 100,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 1,
    });

    const item = await ClientMonitoredItem.create(
      subscription,
      { nodeId: SPEED_NODE, attributeId: AttributeIds.Value },
      { samplingInterval: 50, discardOldest: true, queueSize: 10 },
      TimestampsToReturn.Both,
    );

    const seen: number[] = [];
    item.on('changed', (dataValue) => {
      if (typeof dataValue.value.value === 'number') seen.push(dataValue.value.value);
    });

    // 첫 통지(현재값)를 받을 때까지 기다린다
    await new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (seen.length > 0) {
          clearInterval(wait);
          resolve();
        }
      }, 20);
    });
    expect(seen[0]).toBeCloseTo(1200.5);

    // 수집기가 새 값을 넣었다고 치고 — 아무도 묻지 않았는데 알려 와야 한다
    speed = '1450.25';
    await server.refresh();

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const wait = setInterval(() => {
        if (seen.some((value) => Math.abs(value - 1450.25) < 0.001)) {
          clearInterval(wait);
          resolve();
        } else if (Date.now() - started > 8000) {
          clearInterval(wait);
          reject(new Error(`구독 통지가 오지 않았습니다. 받은 값: ${seen.join(', ')}`));
        }
      }, 50);
    });

    await subscription.terminate();
  }, 20_000);

  it('🔴 뼈대가 그대로면 노드를 다시 만들지 않는다 — 다시 만들면 구독이 끊긴다', async () => {
    const before = server.currentStatus().variables;
    await server.refresh();
    expect(server.currentStatus().variables).toBe(before);
  });
});
