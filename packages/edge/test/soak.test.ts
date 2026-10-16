/**
 * The outage soak of the remote-collector plan (R2: "인터넷 30분 끊김 뒤 복구"): the server is gone for real minutes
 * while the edge keeps reading, then it comes back on the same address and every sample read meanwhile arrives once.
 *
 *     EDGE_SOAK_MINUTES=30 npx vitest run packages/edge/test/soak.test.ts
 *
 * Skipped unless EDGE_SOAK_MINUTES is set — it takes as long as it says.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { createHttpServer } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { EdgeAgent, parseEdgeConfig } from '../src/index.js';
import { startTestServer } from '../../opcua/test/server.js';

const minutes = Number(process.env['EDGE_SOAK_MINUTES'] ?? 0);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => process.stdout.write(`[soak ${new Date().toISOString()}] ${line}\n`);

describe.skipIf(!(minutes > 0))('remote collector — outage soak', () => {
  it(`loses nothing over a ${minutes}-minute outage`, async () => {
    process.env['EDGE'] = 'on';
    const opcua = await startTestServer(14960);
    const store = new InMemoryStore();
    const pkg = readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')));
    pkg.environment.submodels!.push(buildAidSubmodel({
      assetName: 'RollFormingMachine', iriBase: 'https://www.smart-factory.kr/ids', endpoint: opcua.endpoint,
      tags: [{ name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float' }, { name: 'CycleCount', href: 'ns=1;s=Machine.CycleCount', type: 'integer' }],
    }) as never);
    const record = await store.importPackage({ name: 'line1.aasx', package: pkg });
    let server = createHttpServer({ store });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, path: string, body?: unknown) =>
      (await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })).json();

    const { code } = (await call('POST', '/edge/registration-codes')) as { code: string };
    const config = parseEdgeConfig(JSON.stringify({ server: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'edge-soak-')) }), join(tmpdir(), 'edge.json'));
    const agent = new EdgeAgent({ config, credentials: new Map(), log });
    const { deviceId } = await agent.register(code);
    const preview = (await call('GET', `/edge/devices/${deviceId}/read-list-preview`)) as { revision: string; interfaces: { interfaceId: string }[] };
    await call('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [preview.interfaces[0]!.interfaceId]: 1000 } });
    await agent.start();

    await sleep(60_000);
    log(`down — collected ${agent.collected}, stored ${(await store.readValues(record.id, { limit: 10_000_000 })).length}`);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sleep(minutes * 60_000);
    log(`up — collected ${agent.collected}, queued batches ${agent.queue.size}`);
    server = createHttpServer({ store });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    // Backoff tops out at 5 minutes — allow that plus the drain
    const end = Date.now() + 8 * 60_000;
    while (agent.queue.size > 0 && Date.now() < end) await sleep(1000);
    await agent.stop();
    const stored = (await store.readValues(record.id, { limit: 10_000_000 })).length;
    log(`done — collected ${agent.collected}, pending ${agent.pending}, stored ${stored}, duplicates ${agent.sender.stats.duplicates}`);
    server.closeAllConnections();
    server.close();
    await opcua.stop();
    expect(agent.queue.size).toBe(0);
    expect(stored).toBe(agent.collected - agent.pending);
    expect(agent.sender.stats.duplicates).toBe(0);
  }, (minutes + 12) * 60_000);
});
