/**
 * The remote collector against a real AAS Studio server (EDGE=on) and a real OPC UA server — the R2 checks of the
 * remote-collector plan: nothing lost, nothing doubled, recovery after the server was gone, sending through a CONNECT
 * proxy with TLS end to end, and STD-009 T9 (no connection outside the declared ones) and T10 (no remote stop, no
 * listening port, no hidden account) in the edge code.
 *
 * Time is compressed (intervals of 100–200 ms, an outage of seconds); the 30-minute outage runs as a soak, not here.
 */
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer as createPlainServer, request as plainRequest, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { createHttpServer } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EdgeAgent, parseEdgeConfig } from '../src/index.js';
import { startTestServer, type TestServer } from '../../opcua/test/server.js';

let opcua: TestServer;
const golden = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));
const saved = process.env['EDGE'];

beforeAll(async () => {
  process.env['EDGE'] = 'on';
  try {
    opcua = await startTestServer(14940);
  } catch {
    opcua = await startTestServer(14941);
  }
}, 60_000);

afterAll(async () => {
  await opcua?.stop();
  if (saved === undefined) delete process.env['EDGE'];
  else process.env['EDGE'] = saved;
});

/** node-opcua leaves OPENSSL_CONF set to the text "undefined" once loaded — openssl would try to open that file */
function opensslEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env['OPENSSL_CONF'] === 'undefined') delete env['OPENSSL_CONF'];
  return env;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(50);
  }
}

async function aasStudio(port = 0, store = new InMemoryStore()) {
  if (store.listPackages && (await store.listPackages({})).items.length === 0) {
    const pkg = readAasx(golden);
    pkg.environment.submodels!.push(
      buildAidSubmodel({
        assetName: 'RollFormingMachine',
        iriBase: 'https://www.smart-factory.kr/ids',
        endpoint: opcua.endpoint,
        tags: [
          { name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float' },
          { name: 'CycleCount', href: 'ns=1;s=Machine.CycleCount', type: 'integer' },
        ],
      }) as never,
    );
    await store.importPackage({ name: 'line1.aasx', package: pkg });
  }
  const server = createHttpServer({ store });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, store, port: (server.address() as AddressInfo).port };
}

async function call(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return response.json();
}

async function approved(apiPort: number, server: string, extra: Record<string, unknown> = {}) {
  const { code } = (await call(apiPort, 'POST', '/edge/registration-codes')) as { code: string };
  const config = parseEdgeConfig(JSON.stringify({ server, stateDir: mkdtempSync(join(tmpdir(), 'edge-agent-')), flushIntervalMs: 150, ...extra }), join(tmpdir(), 'edge.json'));
  const agent = new EdgeAgent({ config, credentials: new Map() });
  const { deviceId } = await agent.register(code);
  const preview = (await call(apiPort, 'GET', `/edge/devices/${deviceId}/read-list-preview`)) as { revision: string; interfaces: { interfaceId: string }[] };
  await call(apiPort, 'POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [preview.interfaces[0]!.interfaceId]: 100 } });
  return agent;
}

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

async function storedCount(store: InMemoryStore): Promise<number> {
  const [record] = (await store.listPackages({})).items;
  return (await store.readValues(record!.id, { limit: 1_000_000 })).length;
}

describe('remote collector — R2 checks', () => {
  it('reads approved tags and stores every sample once', async () => {
    const { server, store, port } = await aasStudio();
    const agent = await approved(port, `http://127.0.0.1:${port}`);
    try {
      await agent.start();
      await until(async () => (await storedCount(store)) >= 10);
      await agent.stop();
      await agent.tick().catch(() => undefined);
      // Drain what was read before stopping
      const final = new EdgeAgent({ config: agent.config, credentials: new Map() });
      while (final.queue.size > 0) await final.sender.flush();
      expect(agent.collected).toBeGreaterThanOrEqual(10);
      expect(await storedCount(store)).toBe(agent.collected - (agent.pending - final.queue.size));
      expect(agent.sender.stats.duplicates + final.sender.stats.duplicates).toBe(0);
      expect(agent.sender.stats.rejectedSamples).toBe(0);
    } finally {
      await agent.stop();
      await close(server);
    }
  }, 60_000);

  it('keeps reading while the server is gone and loses nothing when it comes back', async () => {
    const first = await aasStudio();
    const agent = await approved(first.port, `http://127.0.0.1:${first.port}`);
    let second: Awaited<ReturnType<typeof aasStudio>> | undefined;
    try {
      await agent.start();
      await until(async () => (await storedCount(first.store)) >= 4);
      await close(first.server);
      const before = agent.collected;
      await until(() => agent.collected >= before + 10 && agent.queue.size > 0);
      // While sending is paused the edge does not write a batch every flush interval — a 30-minute outage made 1 769
      //    batches that a rate-limited server could never catch up with (soak, 2026-10-16)
      await sleep(1500);
      expect(agent.queue.size).toBeLessThanOrEqual(2);
      second = await aasStudio(first.port, first.store);
      await until(() => agent.queue.size === 0 && agent.collected > before + 10, 30_000);
      await agent.stop();
      await until(async () => (await storedCount(first.store)) === agent.collected - agent.pending, 10_000);
      expect(agent.sender.stats.duplicates).toBe(0);
      expect(agent.stopped).toBe('stopped');
    } finally {
      await agent.stop();
      if (second) await close(second.server);
    }
  }, 90_000);
});

describe('remote collector — stopping', () => {
  it('a stop keeps what was read on disk, and the next start sends it', async () => {
    const { server, store, port } = await aasStudio();
    const agent = await approved(port, `http://127.0.0.1:${port}`);
    try {
      await agent.start();
      await until(() => agent.collected >= 6);
      await agent.stop();
      const queued = agent.queue.files().reduce((sum, name) => sum + agent.queue.read(name).samples.length, 0);
      expect(agent.pending).toBe(queued);
      expect(queued + (await storedCount(store))).toBe(agent.collected);
      // The next start of the same edge (same state folder) sends them
      const next = new EdgeAgent({ config: agent.config, credentials: new Map() });
      while (next.queue.size > 0) await next.sender.flush();
      expect(await storedCount(store)).toBe(agent.collected);
    } finally {
      await agent.stop();
      await close(server);
    }
  }, 60_000);
});

describe('remote collector — proxy, T9, T10', () => {
  it('sends through a CONNECT proxy with TLS end to end, and opens no connection but the proxy and the PLC (T9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=aas.test',
      '-addext', 'subjectAltName=DNS:aas.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'pipe', env: opensslEnv() });
    const api = await aasStudio();
    // Sockets the harness itself opens (proxy → front, front → AAS Studio) — excluded by identity, not by port, so an
    //    edge that bypassed the proxy and dialled the front directly would still be caught
    const harness = new Set<Socket>();
    // aas.test: TLS in front of AAS Studio, as a reverse proxy would be
    const front = createTlsServer({ cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) }, (req, res) => {
      const upstream = plainRequest({ host: '127.0.0.1', port: api.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on('socket', (socket) => harness.add(socket));
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    const frontPort = (front.address() as AddressInfo).port;
    const tunnels: string[] = [];
    const sockets = new Set<Socket>();
    const proxy = createPlainServer();
    proxy.on('connect', (request, socket: Socket) => {
      sockets.add(socket);
      tunnels.push(request.url ?? '');
      const upstream = connect(frontPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      harness.add(upstream);
      sockets.add(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;

    // T9: every connection this process opens while the edge runs
    const opened: { socket: Socket; address: string }[] = [];
    const record = (message: unknown) => {
      const socket = (message as { socket?: Socket }).socket;
      // Every attempt counts, answered or not — a refused try to an undeclared destination still breaks T9
      socket?.on('connectionAttempt', (ip: string, port: number) => opened.push({ socket, address: `${ip}:${port}` }));
    };
    const agent = await approved(api.port, `https://aas.test:${frontPort}`, { proxy: `http://127.0.0.1:${proxyPort}`, caFile: join(dir, 'cert.pem') });
    subscribe('net.client.socket', record);
    try {
      await agent.start();
      await until(async () => (await storedCount(api.store)) >= 4);
    } finally {
      unsubscribe('net.client.socket', record);
      await agent.stop();
      for (const socket of sockets) socket.destroy();
      await close(api.server);
      front.closeAllConnections();
      front.close();
      proxy.close();
    }
    expect(tunnels.every((authority) => authority === `aas.test:${frontPort}`)).toBe(true);
    const opcuaPort = new URL(opcua.endpoint.replace('opc.tcp', 'http')).port;
    const allowed = new Set([String(proxyPort), opcuaPort]);
    const edge = opened.filter((entry) => !harness.has(entry.socket)).map((entry) => entry.address);
    expect(edge.length).toBeGreaterThan(0);
    expect(edge.filter((address) => !allowed.has(address.split(':').pop()!))).toEqual([]);
  }, 90_000);

  it('T10 — the edge code listens on no port, runs no command, has no remote stop and no built-in account', () => {
    const dir = 'packages/edge/src';
    const source = readdirSync(dir).map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
    const forbidden: [string, RegExp][] = [
      ['listening server', /\bcreateServer\s*\(|\.listen\s*\(/],
      ['running a command', /child_process|\bexecSync\b|\bexecFile\b|\bspawn\s*\(/],
      ['evaluating code', /\beval\s*\(|new Function\s*\(/],
      ['a built-in password', /password\s*[:=]\s*['"][^'"]+['"]/i],
      ['acting on a command from the server', /['"](shutdown|reboot|uninstall|remote-?stop|kill)['"]/i],
    ];
    const found = source.flatMap(({ file, text }) => forbidden.filter(([, pattern]) => pattern.test(text)).map(([what]) => `${file}: ${what}`));
    expect(found).toEqual([]);
    // Only the entry point ends the process — never an answer from the server
    expect(source.filter(({ file, text }) => file !== 'bin.ts' && /process\.exit/.test(text)).map(({ file }) => file)).toEqual([]);
  });
});
