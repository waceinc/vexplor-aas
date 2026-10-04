/**
 * 가상 PLC — 롤포밍기 시늉을 내는 OPC UA 서버.
 *
 * 실물 PLC가 없어도 수집(M8)을 끝까지 보기 위한 것이다. 기획서 Ⅲ-3이 적어 둔
 * "PLC 시뮬레이터 → 현장 방문 없이 사무실 착수" 경로를 그대로 따른다.
 * node-opcua(MIT)에 서버가 함께 들어 있어 별도 설치가 필요 없다.
 *
 * 값이 **시간에 따라 변한다** — 고정값이면 수집이 도는지 눈으로 확인할 수 없다.
 * 나쁜 태그(BrokenSensor)도 하나 두었다. 현장에서 센서 하나가 죽는 일은 흔하고,
 * 그때 나머지 수집이 멈추지 않는지가 중요하다.
 *
 * 사용: node scripts/plc-simulator.mjs [포트]
 *       node scripts/plc-simulator.mjs [포트] --from 설비1.aasx --from 설비2.aasx …
 *
 * `--from`을 주면 **그 설비들의 운전 데이터(OperationalData) 이름대로** 태그를 만든다(2026-09-30).
 * 레퍼런스 번들의 설비 N대를 한 주소에서 흉내 낸다 — 설비마다 오브젝트 하나, 태그 이름 = 모델 idShort.
 * 그래서 「수집 연결 만들기」에서 훑어 고르기만 하면 모델 자리에 그대로 이어진다.
 * 값 규칙은 @aas/opcua simulationPlan. 🔴 시뮬레이션 값이다 — 시연 캡처에 그렇게 적는다.
 */
import { readFileSync } from 'node:fs';
import { readAasx } from '@aas/aasx';
import { SimulatorServer } from '@aas/opcua';
import { DataType, OPCUAServer, StatusCodes, Variant } from 'node-opcua';

const args = process.argv.slice(2);
const sources = args.flatMap((arg, index) => (args[index - 1] === '--from' ? [arg] : []));
const port = Number(args.find((arg, index) => /^\d+$/.test(arg) && args[index - 1] !== '--from') ?? 14840);
const started = Date.now();
const seconds = () => (Date.now() - started) / 1000;

if (sources.length > 0) {
  // ── 모델에서 태그를 만든다 — 도구에 내장된 가상 PLC(@aas/opcua SimulatorServer)와 **같은 코드**다 ──
  const simulator = new SimulatorServer({ port });
  const lines = [];
  for (const file of sources) {
    const machine = await simulator.attach(readAasx(new Uint8Array(readFileSync(file))).environment);
    lines.push(`  ${machine.machine}: 태그 ${machine.tags.length}개  (${file})`);
  }
  console.log('가상 PLC(OPC UA, 시뮬레이션)가 떴습니다.');
  console.log(`  주소: ${simulator.endpoint}`);
  for (const line of lines) console.log(line);
  console.log('  🔴 시뮬레이션 값입니다 — 시연 캡처·문서에 「시뮬레이션」으로 적으십시오.');
  console.log('  멈추려면 Ctrl+C');
  process.on('SIGINT', () => {
    void simulator.stop().then(() => process.exit(0));
  });
} else {
  await rollFormingDemo();
}

/** 예전 그대로의 롤포밍기 시연 — 인자 없이 띄우면 이것이다(사용법 7장이 이 주소를 쓴다) */
async function rollFormingDemo() {
const server = new OPCUAServer({
  port,
  resourcePath: '/UA/RollFormingMachine',
  buildInfo: { productName: '롤포밍기 시뮬레이터', buildNumber: '1', buildDate: new Date(0) },
});
await server.initialize();
const addressSpace = server.engine.addressSpace;
const namespace = addressSpace.getOwnNamespace();
const machine = namespace.addObject({
  organizedBy: addressSpace.rootFolder.objects,
  browseName: 'Machine',
});

/** 읽을 때마다 값을 계산한다 — 실제 설비처럼 흔들리게 */
const variable = (browseName, nodeId, dataType, get) =>
  namespace.addVariable({
    componentOf: machine,
    browseName,
    nodeId,
    dataType,
    value: { get },
  });

variable('MotorSpeed', 's=Machine.MotorSpeed', 'Double', () =>
  // 1200rpm을 중심으로 ±40 흔들린다
  new Variant({ dataType: DataType.Double, value: Number((1200 + Math.sin(seconds() / 5) * 40).toFixed(2)) }),
);

variable('LineSpeed', 's=Machine.LineSpeed', 'Double', () =>
  new Variant({ dataType: DataType.Double, value: Number((18 + Math.sin(seconds() / 7) * 1.5).toFixed(2)) }),
);

variable('MotorTemperature', 's=Machine.MotorTemperature', 'Double', () =>
  // 가동할수록 서서히 오르다 65℃ 부근에서 머문다
  new Variant({ dataType: DataType.Double, value: Number((45 + Math.min(20, seconds() / 30)).toFixed(1)) }),
);

variable('ProductionCount', 's=Machine.ProductionCount', 'UInt32', () =>
  new Variant({ dataType: DataType.UInt32, value: Math.floor(seconds() / 3) }),
);

variable('AlarmActive', 's=Machine.AlarmActive', 'Boolean', () =>
  // 40초마다 5초간 알람이 뜬다
  new Variant({ dataType: DataType.Boolean, value: seconds() % 40 < 5 }),
);

variable('MachineState', 's=Machine.MachineState', 'String', () =>
  new Variant({ dataType: DataType.String, value: seconds() % 40 < 5 ? 'ALARM' : 'RUNNING' }),
);

// 죽은 센서 — 나쁜 상태를 돌려준다
variable('BrokenSensor', 's=Machine.BrokenSensor', 'Double', () => StatusCodes.BadDeviceFailure);

await server.start();

console.log('가상 PLC(OPC UA)가 떴습니다.');
console.log(`  주소: opc.tcp://127.0.0.1:${port}/UA/RollFormingMachine`);
console.log('  태그: MotorSpeed · LineSpeed · MotorTemperature · ProductionCount · AlarmActive · MachineState · BrokenSensor(고장)');
console.log('  멈추려면 Ctrl+C');

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});
}
