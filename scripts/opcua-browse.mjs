/**
 * A tool to **see with your own eyes** what is being served over OPC UA.
 *
 * Checks on the spot whether "the server really works" without installing a viewer such as UaExpert.
 * It connects, browses the tree, reads values, and with `--watch` also sets up a **subscription** —
 * subscriptions are what REST cannot do, and the reason the OPC UA server exists.
 *
 *   node scripts/opcua-browse.mjs                                   default opc.tcp://127.0.0.1:4840/UA/AAS
 *   node scripts/opcua-browse.mjs opc.tcp://192.168.0.10:4840/UA/AAS
 *   node scripts/opcua-browse.mjs --watch                           watch for 30 seconds whether values stream in
 */
import { AttributeIds, ClientMonitoredItem, NodeClass, OPCUAClient, TimestampsToReturn } from 'node-opcua';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const endpoint = args.find((a) => a.startsWith('opc.tcp://')) ?? 'opc.tcp://127.0.0.1:4840/UA/AAS';

const client = OPCUAClient.create({ endpointMustExist: false });
console.log(`Connecting: ${endpoint}`);
await client.connect(endpoint);
const session = await client.createSession();
console.log('Connected.\n');

const browse = async (nodeId) =>
  (await session.browse(nodeId)).references?.map((ref) => ({
    name: ref.browseName.name ?? '',
    id: ref.nodeId.toString(),
    // Important: do not decide "variable" by child count — it would try to read values of empty submodels (folders) too
    isVariable: ref.nodeClass === NodeClass.Variable,
  })) ?? [];

const read = async (nodeId) => {
  const value = await session.read({ nodeId, attributeId: AttributeIds.Value });
  return value.statusCode.name === 'Good' ? String(value.value.value) : `(${value.statusCode.name})`;
};

/** Variables: read the value. Folders: descend further */
const variables = [];
async function walk(nodeId, depth) {
  for (const child of await browse(nodeId)) {
    if (child.isVariable) {
      variables.push(child);
      console.log(`${'  '.repeat(depth)}· ${child.name.padEnd(36 - depth * 2)} ${await read(child.id)}`);
      continue;
    }
    const children = await browse(child.id);
    console.log(`${'  '.repeat(depth)}▸ ${child.name}${children.length === 0 ? '  (empty)' : ''}`);
    await walk(child.id, depth + 1);
  }
}

const roots = await browse('ns=1;s=AAS');
if (roots.length === 0) {
  console.log('No files are being served. Check that an AASX is loaded in the authoring tool and that OPCUA_SERVER=on.');
} else {
  await walk('ns=1;s=AAS', 0);
  console.log(`\n${variables.length} variables.`);
}

if (watch && variables.length > 0) {
  console.log('\nSubscribing — value changes are printed here (30 s). Press Ctrl+C to stop.\n');
  const subscription = await session.createSubscription2({
    requestedPublishingInterval: 500,
    requestedLifetimeCount: 200,
    requestedMaxKeepAliveCount: 20,
    maxNotificationsPerPublish: 200,
    publishingEnabled: true,
    priority: 1,
  });
  for (const variable of variables) {
    const item = await ClientMonitoredItem.create(
      subscription,
      { nodeId: variable.id, attributeId: AttributeIds.Value },
      { samplingInterval: 250, discardOldest: true, queueSize: 10 },
      TimestampsToReturn.Both,
    );
    item.on('changed', (dataValue) => {
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(`  ${stamp}  ${variable.name} = ${dataValue.value.value} [${dataValue.statusCode.name}]`);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  await subscription.terminate();
}

await session.close();
await client.disconnect();
console.log('\nDone.');
