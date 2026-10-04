/**
 * 시험용 OPC UA 서버 — 실물 PLC 없이 **진짜 프로토콜**로 왕복한다.
 *
 * node-opcua에 서버가 함께 들어 있어 가능한 일이다. 가짜 리더로만 시험하면
 * 어댑터가 프로토콜을 제대로 다루는지는 끝내 확인되지 않는다.
 */
import { DataType, OPCUAServer, StatusCodes, Variant } from 'node-opcua';

export interface TestServer {
  endpoint: string;
  /** 값을 바꿔 수집 결과가 따라오는지 보기 위해 */
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
   * 🔴 **정수 값을 가진 Int32 태그.** 값만 보면 float와 구별되지 않아서
   *    자료형 판정이 DataType을 제대로 읽는지 여기서만 드러난다 —
   *    실제로 이 자리가 깨져 정수 태그가 죄다 string으로 잡혔다(2026-09-01 실측).
   */
  namespace.addVariable({
    componentOf: device,
    browseName: 'CycleCount',
    nodeId: 's=Machine.CycleCount',
    dataType: 'Int32',
    value: { get: () => new Variant({ dataType: DataType.Int32, value: 5200 }) },
  });

  // 나쁜 상태를 돌려주는 태그 — 현장에서 센서가 죽은 상황
  namespace.addVariable({
    componentOf: device,
    browseName: 'BrokenSensor',
    nodeId: 's=Machine.BrokenSensor',
    dataType: 'Double',
    value: { get: () => StatusCodes.BadDeviceFailure },
  });

  /*
   * 🔴 **아직 값이 안 들어온 태그** — 「고장」이 아니라 「대기」다.
   *    설비 기동 직후에 흔한 상태이고, 우리 산출물은 Type/Template이라 빈 값이 정상이다.
   *    BrokenSensor(진짜 고장)와 **한 서버 안에 나란히** 둬야 둘을 가르는지가 확인된다 —
   *    따로 두면 "둘 다 Bad로 시작하니 같은 것"이라는 착각을 시험이 잡아 주지 못한다.
   */
  namespace.addVariable({
    componentOf: device,
    browseName: 'NotYetReady',
    nodeId: 's=Machine.NotYetReady',
    dataType: 'Double',
    value: { get: () => StatusCodes.BadWaitingForInitialData },
  });

  await server.start();
  // 🔴 서버가 광고하는 주소는 호스트명(.local)이라 이 기계에서 못 풀고 60초를 매단다(실측).
  // 시험은 루프백으로 붙는다 — 프로토콜 왕복을 보는 것이 목적이고 이름 해석은 곁가지다
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
