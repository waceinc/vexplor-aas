/**
 * Virtual PLC — an OPC UA server that imitates a roll-forming machine.
 *
 * Lets data collection (M8) be exercised end to end without a physical PLC. It follows the path laid out in
 * section III-3 of the plan: "PLC simulator -> start in the office without a site visit".
 * node-opcua (MIT) ships with a server, so nothing extra needs to be installed.
 *
 * Values **change over time** — with fixed values you cannot see by eye whether collection is running.
 * There is also one bad tag (BrokenSensor). A single dead sensor is common on site, and what matters is
 * that the rest of the collection keeps going when it happens.
 *
 * Usage: node scripts/plc-simulator.mjs [port]
 *        node scripts/plc-simulator.mjs [port] --from machine1.aasx --from machine2.aasx …
 *
 * With `--from`, tags are created **after the names in those machines' OperationalData** (2026-09-30).
 * Imitates the N machines of a reference bundle at one address — one object per machine, tag name = model idShort.
 * So in "Create collection connection" you only browse and pick, and it maps straight onto the model.
 * Value rules: @aas/opcua simulationPlan. Important: these are simulated values — label demo captures accordingly.
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
  // ── Build tags from the model — **the same code** as the tool's built-in virtual PLC (@aas/opcua SimulatorServer) ──
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

/** The original roll-forming machine demo — started when no arguments are given (chapter 7 of the usage guide uses this address) */
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

/** Computes the value on every read — so it fluctuates like a real machine */
const variable = (browseName, nodeId, dataType, get) =>
  namespace.addVariable({
    componentOf: machine,
    browseName,
    nodeId,
    dataType,
    value: { get },
  });

variable('MotorSpeed', 's=Machine.MotorSpeed', 'Double', () =>
  // Fluctuates ±40 around 1200 rpm
  new Variant({ dataType: DataType.Double, value: Number((1200 + Math.sin(seconds() / 5) * 40).toFixed(2)) }),
);

variable('LineSpeed', 's=Machine.LineSpeed', 'Double', () =>
  new Variant({ dataType: DataType.Double, value: Number((18 + Math.sin(seconds() / 7) * 1.5).toFixed(2)) }),
);

variable('MotorTemperature', 's=Machine.MotorTemperature', 'Double', () =>
  // Rises slowly while running and settles around 65 °C
  new Variant({ dataType: DataType.Double, value: Number((45 + Math.min(20, seconds() / 30)).toFixed(1)) }),
);

variable('ProductionCount', 's=Machine.ProductionCount', 'UInt32', () =>
  new Variant({ dataType: DataType.UInt32, value: Math.floor(seconds() / 3) }),
);

variable('AlarmActive', 's=Machine.AlarmActive', 'Boolean', () =>
  // Alarm raised for 5 seconds every 40 seconds
  new Variant({ dataType: DataType.Boolean, value: seconds() % 40 < 5 }),
);

variable('MachineState', 's=Machine.MachineState', 'String', () =>
  new Variant({ dataType: DataType.String, value: seconds() % 40 < 5 ? 'ALARM' : 'RUNNING' }),
);

// Dead sensor — returns a bad status
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
