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
 *        node scripts/plc-simulator.mjs [port] --user operator:secret
 *        node scripts/plc-simulator.mjs [port] --from machine1.aasx --from machine2.aasx …
 *
 * With `--user name:password` the roll-forming demo refuses anonymous sessions and offers only Sign and SignAndEncrypt
 * (Basic256Sha256 and newer) — to try "Login required" and a security mode in "Create collection link" (2.8.0).
 * Client certificates are accepted on first sight, which a real PLC would not do.
 *
 * With `--from`, tags are created **after the names in those machines' OperationalData** (2026-09-30).
 * Imitates the N machines of a reference bundle at one address — one object per machine, tag name = model idShort.
 * So in "Create collection connection" you only browse and pick, and it maps straight onto the model.
 * Value rules: @aas/opcua simulationPlan. Important: these are simulated values — label demo captures accordingly.
 */
import { readFileSync } from 'node:fs';
import { readAasx } from '@aas/aasx';
import { SimulatorServer } from '@aas/opcua';
import { DataType, MessageSecurityMode, OPCUACertificateManager, OPCUAServer, SecurityPolicy, StatusCodes, Variant } from 'node-opcua';

const args = process.argv.slice(2);
const sources = args.flatMap((arg, index) => (args[index - 1] === '--from' ? [arg] : []));
const port = Number(args.find((arg, index) => /^\d+$/.test(arg) && args[index - 1] !== '--from' && args[index - 1] !== '--user') ?? 14840);
const login = args.flatMap((arg, index) => (args[index - 1] === '--user' ? [arg] : []))[0];
const started = Date.now();
const seconds = () => (Date.now() - started) / 1000;

if (sources.length > 0) {
  // ── Build tags from the model — **the same code** as the tool's built-in virtual PLC (@aas/opcua SimulatorServer) ──
  const simulator = new SimulatorServer({ port });
  const lines = [];
  for (const file of sources) {
    const machine = await simulator.attach(readAasx(new Uint8Array(readFileSync(file))).environment);
    lines.push(`  ${machine.machine}: ${machine.tags.length} tags  (${file})`);
  }
  console.log('Virtual PLC (OPC UA, simulation) is up.');
  console.log(`  Endpoint: ${simulator.endpoint}`);
  for (const line of lines) console.log(line);
  console.log('  [WARN] These are simulated values — label demo captures and documents as "simulation".');
  console.log('  Press Ctrl+C to stop');
  process.on('SIGINT', () => {
    void simulator.stop().then(() => process.exit(0));
  });
} else {
  await rollFormingDemo();
}

/** The original roll-forming machine demo — started when no arguments are given (chapter 7 of the usage guide uses this address) */
async function rollFormingDemo() {
const [user, password] = login ? [login.slice(0, login.indexOf(':')), login.slice(login.indexOf(':') + 1)] : [];
const secured = login
  ? {
      securityModes: [MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
      securityPolicies: [SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep, SecurityPolicy.Aes256_Sha256_RsaPss],
      allowAnonymous: false,
      userManager: { isValidUser: (name, secret) => name === user && secret === password },
      serverCertificateManager: new OPCUACertificateManager({ automaticallyAcceptUnknownCertificate: true }),
    }
  : {};
const server = new OPCUAServer({
  port,
  resourcePath: '/UA/RollFormingMachine',
  buildInfo: { productName: 'Roll Forming Machine Simulator', buildNumber: '1', buildDate: new Date(0) },
  ...secured,
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

console.log(login ? `Virtual PLC (OPC UA) is up — Sign / SignAndEncrypt only, user ${user}.` : 'Virtual PLC (OPC UA) is up.');
console.log(`  Endpoint: opc.tcp://127.0.0.1:${port}/UA/RollFormingMachine`);
console.log('  Tags: MotorSpeed · LineSpeed · MotorTemperature · ProductionCount · AlarmActive · MachineState · BrokenSensor (faulty)');
console.log('  Press Ctrl+C to stop');

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});
}
