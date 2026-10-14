/**
 * M6/M7 end to end — **our tool becomes an OPC UA server**.
 *
 * Tests the diagram in plan section III-3 as is:
 *   collected values ──▶ our server ──subscribe──▶ upstream app
 *
 * Important: the core of this test is **subscription**, not reads. If reads were enough, Part 2 REST would do
 *    and there would be no reason to run an OPC UA server. The crux is whether **the server notifies first** on change.
 * Important: and whether **writes are blocked** — checks that value sync option A holds at the protocol level.
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

/** One device — one static spec value + one value that changes on site */
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
/** Simulates the collector changing a value */
let speed: string | undefined = '1200.5';

const SPEED_NODE = `ns=1;s=${PID}/https://ktl/sm/tech/MotorSpeed`;

async function startOn(port: number): Promise<void> {
  server = new AasOpcUaServer({
    port,
    hostname: '127.0.0.1',
    load: async (): Promise<PublishPlan[]> => [
      planForPackage(environmentWith(speed), { packageId: PID, name: '롤포밍기' }),
    ],
    // These tests read anonymously over None — the unauthenticated mode must be asked for explicitly
    security: { mode: 'insecure' },
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

describe('exposing AAS over OPC UA', () => {
  it('the server comes up and reports its status', () => {
    const status = server.currentStatus();
    expect(status.running).toBe(true);
    expect(status.packages).toBe(1);
    expect(status.variables).toBe(3);
  });

  it('the AAS hierarchy is browsable as is — AAS > device > submodel > element', async () => {
    // This is what upstream apps actually do: browse to find things without knowing addresses
    const names = async (nodeId: string): Promise<string[]> =>
      (await session.browse(nodeId)).references?.map((ref) => ref.browseName.name ?? '') ?? [];

    expect(await names('ns=1;s=AAS')).toContain('롤포밍기');
    expect(await names(`ns=1;s=${PID}`)).toContain('TechnicalData');
    expect(await names(`ns=1;s=${PID}/https://ktl/sm/tech`)).toEqual(
      expect.arrayContaining(['ManufacturerName', 'MotorSpeed', 'NotCollectedYet']),
    );
  });

  it('reads static specs (values written in the model)', async () => {
    const read = await session.read({
      nodeId: `ns=1;s=${PID}/https://ktl/sm/tech/ManufacturerName`,
      attributeId: AttributeIds.Value,
    });
    expect(read.statusCode).toBe(StatusCodes.Good);
    expect(read.value.value).toBe('한국기계');
  });

  it('reads collected values in their data type — Double, not a string', async () => {
    const read = await session.read({ nodeId: SPEED_NODE, attributeId: AttributeIds.Value });
    expect(read.statusCode).toBe(StatusCodes.Good);
    expect(read.value.dataType).toBe(DataType.Double);
    expect(read.value.value).toBeCloseTo(1200.5);
  });

  it('Important: a value not yet received is reported as "none" — not invented as 0', async () => {
    const read = await session.read({
      nodeId: `ns=1;s=${PID}/https://ktl/sm/tech/NotCollectedYet`,
      attributeId: AttributeIds.Value,
    });
    expect(read.statusCode).toBe(StatusCodes.BadWaitingForInitialData);
  });

  it('Important: writes are blocked — value sync option A (file is the source) is enforced in the protocol', async () => {
    const status = await session.write({
      nodeId: SPEED_NODE,
      attributeId: AttributeIds.Value,
      value: { value: new Variant({ dataType: DataType.Double, value: 9999 }) },
    });
    expect(status).not.toBe(StatusCodes.Good);
    // Blocked, so the value must be unchanged
    const read = await session.read({ nodeId: SPEED_NODE, attributeId: AttributeIds.Value });
    expect(read.value.value).toBeCloseTo(1200.5);
  });

  it('Important: value changes are pushed to subscribers — this is what REST cannot do', async () => {
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

    // Wait until the first notification (current value) arrives
    await new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (seen.length > 0) {
          clearInterval(wait);
          resolve();
        }
      }, 20);
    });
    expect(seen[0]).toBeCloseTo(1200.5);

    // Pretend the collector wrote a new value — it must be notified without anyone asking
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

  it('Important: does not rebuild nodes when the structure is unchanged — rebuilding drops subscriptions', async () => {
    const before = server.currentStatus().variables;
    await server.refresh();
    expect(server.currentStatus().variables).toBe(before);
  });
});
