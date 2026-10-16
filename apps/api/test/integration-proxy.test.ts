/**
 * Webhooks through an HTTP CONNECT proxy (plan gap 1): `INTEGRATION_PROXY`, `INTEGRATION_NO_PROXY`.
 *
 * Behind a factory proxy the server often cannot resolve outside names itself — the proxy does. So with a proxy the
 * egress rules judge the **destination name** (the plan: "차단 규칙은 목적지 이름에"), the proxy receives the name, not
 * an address, and TLS still verifies the receiver's certificate end to end through the tunnel.
 *
 * A self-signed certificate for `receiver.test` is made with openssl for the test (present on macOS and CI runners).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTarget, egressPolicyFromEnv } from '../src/integration/egress.js';
import { sendWebhook } from '../src/integration/webhook.js';

const noDns = async (host: string): Promise<string[]> => {
  throw new Error(`resolved ${host} — a proxied target must not be resolved here`);
};

let cert = '';
let key = '';
let receiver: Server;
let proxy: Server;
let receiverPort = 0;
let proxyPort = 0;
const tunnels: string[] = [];
const sockets = new Set<{ destroy: () => void }>();
const received: string[] = [];
let refuseWith407 = false;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=receiver.test',
    '-addext', 'subjectAltName=DNS:receiver.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  key = readFileSync(join(dir, 'key.pem'), 'utf8');

  receiver = createHttpsServer({ cert, key }, (request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push(body);
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverPort = (receiver.address() as AddressInfo).port;

  // A CONNECT proxy that resolves every name to this machine — as a corporate proxy resolves outside names itself
  proxy = createHttpServer();
  proxy.on('connect', (request, socket) => {
    sockets.add(socket);
    tunnels.push(`${request.url} ${request.headers['proxy-authorization'] ?? ''}`.trim());
    if (refuseWith407) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const upstream = connect(receiverPort, '127.0.0.1', () => {
      sockets.add(upstream);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxy.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  receiver?.closeAllConnections();
  proxy?.closeAllConnections();
  await new Promise((resolve) => receiver?.close(resolve));
  await new Promise((resolve) => proxy?.close(resolve));
});

const policy = (extra: Record<string, string> = {}) =>
  egressPolicyFromEnv({ INTEGRATION_PROXY: `http://user:secret@127.0.0.1:${proxyPort}`, ...extra }, false, noDns);

describe('egress with a proxy', () => {
  it('sends a public name through the proxy without resolving it', async () => {
    const check = await checkTarget('https://receiver.example.com/hook', 'webhook', policy());
    expect(check).toMatchObject({ ok: true, host: 'receiver.example.com', port: 443, proxy: { host: '127.0.0.1', port: proxyPort } });
  });

  it('still refuses this server, link-local addresses and blocked ports by name or literal', async () => {
    expect((await checkTarget('https://localhost/hook', 'webhook', policy())).ok).toBe(false);
    expect((await checkTarget('https://169.254.169.254/latest', 'webhook', policy())).ok).toBe(false);
    expect((await checkTarget('https://receiver.example.com:22/', 'webhook', policy())).ok).toBe(false);
  });

  it('does not send plain http or MQTT through the proxy', async () => {
    expect((await checkTarget('http://receiver.example.com/hook', 'webhook', policy())).ok).toBe(false);
    expect((await checkTarget('mqtts://broker.example.com', 'mqtt', policy())).ok).toBe(false);
  });

  it('goes direct (with the usual address rules) for internal names and INTEGRATION_NO_PROXY', async () => {
    const direct = egressPolicyFromEnv(
      { INTEGRATION_PROXY: `http://127.0.0.1:${proxyPort}`, INTEGRATION_NO_PROXY: 'receiver.partner.com', AAS_INTEGRATION_ALLOW: 'mes.plant.local' },
      false,
      async () => ['10.0.0.9'],
    );
    expect(await checkTarget('https://mes.plant.local/hook', 'webhook', direct)).toMatchObject({ ok: true, address: '10.0.0.9' });
    expect((await checkTarget('https://mes.plant.local/hook', 'webhook', direct)).ok && 'proxy' in (await checkTarget('https://mes.plant.local/hook', 'webhook', direct))).toBe(false);
    // NO_PROXY goes direct, and a private answer still needs AAS_INTEGRATION_ALLOW
    expect((await checkTarget('https://receiver.partner.com/hook', 'webhook', direct)).ok).toBe(false);
  });
});

describe('webhook through a CONNECT proxy', () => {
  it('tunnels to the name, verifies the receiver certificate end to end, and sends proxy credentials', async () => {
    const outcome = await sendWebhook({
      url: `https://receiver.test:${receiverPort}/hook`,
      address: `127.0.0.1:${proxyPort}`,
      body: Buffer.from('{"hello":1}'),
      headers: {},
      proxy: { host: '127.0.0.1', port: proxyPort, authorization: `Basic ${Buffer.from('user:secret').toString('base64')}` },
      ca: cert,
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.statusCode).toBe(204);
    expect(tunnels.at(-1)).toBe(`receiver.test:${receiverPort} Basic ${Buffer.from('user:secret').toString('base64')}`);
    expect(received.at(-1)).toBe('{"hello":1}');
  });

  it('fails on a certificate for another name, and reports a proxy refusal', async () => {
    const wrongName = await sendWebhook({
      url: `https://other.test:${receiverPort}/hook`,
      address: 'proxy',
      body: Buffer.from('{}'),
      headers: {},
      proxy: { host: '127.0.0.1', port: proxyPort },
      ca: cert,
    });
    expect(wrongName.statusCode).toBeUndefined();
    expect(wrongName.error).toMatch(/altname|certificate|hostname/i);

    refuseWith407 = true;
    try {
      const refused = await sendWebhook({ url: `https://receiver.test:${receiverPort}/hook`, address: 'proxy', body: Buffer.from('{}'), headers: {}, proxy: { host: '127.0.0.1', port: proxyPort }, ca: cert });
      expect(refused.statusCode).toBeUndefined();
      expect(refused.error).toMatch(/proxy.*407/i);
    } finally {
      refuseWith407 = false;
    }
  });
});
