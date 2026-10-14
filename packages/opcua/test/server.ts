/**
 * Test OPC UA server — round-trips over the **real protocol** without a physical PLC.
 *
 * Possible because node-opcua ships a server. Testing only with a fake reader
 * never confirms that the adapter handles the protocol correctly.
 */
import { DataType, OPCUAServer, StatusCodes, Variant } from 'node-opcua';

export interface TestServer {
  endpoint: string;
  /** Change the value to see that collected results follow it */
  setSpeed(value: number): void;
  stop(): Promise<void>;
}

export async function startTestServer(port: number): Promise<TestServer> {
  const server = new OPCUAServer({
    port,
    resourcePath: '/UA/RollFormingMachine',
    buildInfo: { productName: 'AAS 시험용 롤포밍기', buildNumber: '1', buildDate: new Date(0) },
  });

  await server.initialize();

  const addressSpace = server.engine.addressSpace!;
  const namespace = addressSpace.getOwnNamespace();
  const device = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: 'Machine',
  });

  let speed = 1200.5;
  namespace.addVariable({
    componentOf: device,
    browseName: 'MotorSpeed',
    nodeId: 's=Machine.MotorSpeed',
    dataType: 'Double',
    value: { get: () => new Variant({ dataType: DataType.Double, value: speed }) },
  });

  namespace.addVariable({
    componentOf: device,
    browseName: 'AlarmActive',
    nodeId: 's=Machine.AlarmActive',
    dataType: 'Boolean',
    value: { get: () => new Variant({ dataType: DataType.Boolean, value: false }) },
  });

  /*
   * Important: **an Int32 tag holding an integer value.** By value alone it is indistinguishable from float,
   *    so only here does it show whether type detection reads DataType correctly —
   *    this spot actually broke and every integer tag was detected as string (measured 2026-09-01).
   */
  namespace.addVariable({
    componentOf: device,
    browseName: 'CycleCount',
    nodeId: 's=Machine.CycleCount',
    dataType: 'Int32',
    value: { get: () => new Variant({ dataType: DataType.Int32, value: 5200 }) },
  });

  // Tag that returns a bad status — a sensor that died on site
  namespace.addVariable({
    componentOf: device,
    browseName: 'BrokenSensor',
    nodeId: 's=Machine.BrokenSensor',
    dataType: 'Double',
    value: { get: () => StatusCodes.BadDeviceFailure },
  });

  /*
   * Important: **a tag with no value yet** — "waiting", not "broken".
   *    Common right after the machine starts; our output is a Type/Template, so an empty value is normal.
   *    It must sit **side by side in one server** with BrokenSensor (a real failure) to confirm the two are told apart —
   *    kept apart, the test would not catch the mistake "both start with Bad, so they are the same".
   */
  namespace.addVariable({
    componentOf: device,
    browseName: 'NotYetReady',
    nodeId: 's=Machine.NotYetReady',
    dataType: 'Double',
    value: { get: () => StatusCodes.BadWaitingForInitialData },
  });

  await server.start();
  // Important: the address the server advertises is a hostname (.local) that this machine cannot resolve, hanging for 60 s (measured).
  // Tests connect over loopback — the goal is the protocol round-trip; name resolution is a side issue
  const endpoint = `opc.tcp://127.0.0.1:${port}/UA/RollFormingMachine`;

  return {
    endpoint,
    setSpeed: (value: number) => {
      speed = value;
    },
    stop: async () => {
      await server.shutdown();
    },
  };
}
