/**
 * Egress policy — SSRF protection of webhook and MQTT targets (design §5.4, platform test 7.4).
 *
 * Important: every "refused" row here must fail when its protection is removed. DNS is injected; nothing leaves the
 *    machine. The rebinding case connects for real to 127.0.0.1 through the pinned lookup.
 */
import { describe, expect, it } from 'vitest';

import { checkTarget, egressPolicyFromEnv, parseAllowEntry, pinnedLookup, type EgressPolicy } from '../src/integration/egress.js';
import { classifyAddress, formatIp, parseIp } from '../src/integration/egress-ip.js';
import { sendWebhook } from '../src/integration/webhook.js';
import { startReceiver } from './helpers/integration-scenarios.js';

function policy(allow = '', answers: Record<string, string[]> = {}, demo = false): EgressPolicy {
  return egressPolicyFromEnv({ AAS_INTEGRATION_ALLOW: allow }, demo, async (host) => {
    const found = answers[host];
    if (!found) throw new Error(`ENOTFOUND ${host}`);
    return found;
  });
}

/**
 * The resolver answers "public" even for names that must never be connected to — so a refusal below comes from the
 * policy itself, not from a lookup failing by accident.
 */
const PUBLIC = {
  'hooks.example.com': ['93.184.216.34'],
  localhost: ['93.184.216.34'],
  'api.localhost': ['93.184.216.34'],
  '2130706433': ['93.184.216.34'],
};

describe('address classification', () => {
  it.each([
    ['127.0.0.1', 'blocked'],
    ['127.255.0.9', 'blocked'],
    ['0.0.0.0', 'blocked'],
    ['169.254.169.254', 'blocked'],
    ['168.63.129.16', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['255.255.255.255', 'blocked'],
    ['::1', 'blocked'],
    ['::', 'blocked'],
    ['fe80::1', 'blocked'],
    ['ff02::1', 'blocked'],
    ['::ffff:127.0.0.1', 'blocked'],
    ['::ffff:7f00:1', 'blocked'],
    ['::127.0.0.1', 'blocked'],
    ['64:ff9b::7f00:1', 'blocked'],
    ['64:ff9b::169.254.169.254', 'blocked'],
    ['2002:7f00:1::', 'blocked'],
    ['10.0.0.5', 'private'],
    ['172.16.4.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['fd00::5', 'private'],
    ['::ffff:10.0.0.5', 'private'],
    ['64:ff9b::a00:5', 'private'],
    ['172.32.0.1', 'public'],
    ['93.184.216.34', 'public'],
    ['2606:2800:220:1::1', 'public'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(parseIp(address)!)).toBe(expected);
  });

  it('formats addresses back (IPv4-mapped as IPv4, IPv6 compressed)', () => {
    expect(formatIp(parseIp('::ffff:10.0.0.5')!)).toBe('10.0.0.5');
    expect(formatIp(parseIp('2606:2800:0:0:0:0:0:1')!)).toBe('2606:2800::1');
    expect(parseIp('not-an-ip')).toBeUndefined();
  });
});

describe('allow entries', () => {
  it('reads CIDR, IP, hostname, ports and bracketed IPv6', () => {
    expect(parseAllowEntry('10.20.0.0/16')).toMatchObject({ text: '10.20.0.0/16' });
    expect(parseAllowEntry('10.20.1.5:8080')).toMatchObject({ port: 8080 });
    expect(parseAllowEntry('MES.plant.local')).toMatchObject({ host: 'mes.plant.local' });
    expect(parseAllowEntry('[fd00::/8]:443')).toMatchObject({ port: 443 });
    expect(parseAllowEntry('fd00::5')).toMatchObject({ text: 'fd00::5' });
  });

  it('an unreadable entry is a startup error, not silently ignored', () => {
    expect(() => egressPolicyFromEnv({ AAS_INTEGRATION_ALLOW: '10.0.0.0/99' }, false)).toThrow(/AAS_INTEGRATION_ALLOW/);
    expect(() => egressPolicyFromEnv({ AAS_INTEGRATION_ALLOW: 'host:notaport' }, false)).toThrow();
  });
});

describe('checkTarget — refused targets (each fails if its protection is removed)', () => {
  it.each([
    ['loopback IP', 'https://127.0.0.1/hook'],
    ['localhost by name', 'https://localhost/hook'],
    ['*.localhost', 'https://api.localhost/hook'],
    ['IPv6 loopback', 'https://[::1]/hook'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/hook'],
    ['unspecified', 'https://0.0.0.0/hook'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data'],
    ['Azure platform endpoint (WireServer)', 'http://168.63.129.16/machine?comp=goalstate'],
    ['link-local IPv6', 'https://[fe80::1]/hook'],
    ['decimal loopback', 'https://2130706433/hook'],
    ['hex-dotted loopback', 'https://0x7f.1/hook'],
    ['decimal loopback over mqtt (non-special scheme)', 'mqtts://2130706433:8883'],
    ['private without allow', 'https://10.0.0.5/hook'],
    ['file scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://hooks.example.com/'],
    ['userinfo on webhook', 'https://user:pass@hooks.example.com/hook'],
    ['plain http to a public host', 'http://hooks.example.com/hook'],
    ['blocked port (Redis)', 'https://hooks.example.com:6379/'],
    ['blocked port (Modbus)', 'https://hooks.example.com:502/'],
    ['blocked port (LS ELECTRIC XGT dedicated protocol)', 'https://hooks.example.com:2004/'],
  ])('%s', async (_name, url) => {
    const kind = url.startsWith('mqtt') ? 'mqtt' : 'webhook';
    const result = await checkTarget(url, kind, policy('', PUBLIC));
    expect(result.ok).toBe(false);
  });

  it('a hostname resolving to loopback is refused', async () => {
    const result = await checkTarget('https://evil.example/hook', 'webhook', policy('', { 'evil.example': ['127.0.0.1'] }));
    expect(result).toMatchObject({ ok: false });
  });

  it('Important: mixed answers — one private answer refuses the whole host', async () => {
    const result = await checkTarget('https://mixed.example/hook', 'webhook', policy('', { 'mixed.example': ['93.184.216.34', '10.0.0.5'] }));
    expect(result.ok).toBe(false);
  });

  it('loopback stays refused even when the allowlist names it', async () => {
    const result = await checkTarget('http://127.0.0.1:9000/hook', 'webhook', policy('127.0.0.0/8,localhost'));
    expect(result.ok).toBe(false);
  });

  it('demo mode refuses everything', async () => {
    const result = await checkTarget('https://hooks.example.com/hook', 'webhook', policy('', PUBLIC, true));
    expect(result.ok).toBe(false);
  });

  it('mqtt subscriptions accept only mqtt / mqtts, webhooks only http / https', async () => {
    expect((await checkTarget('https://hooks.example.com/', 'mqtt', policy('', PUBLIC))).ok).toBe(false);
    expect((await checkTarget('mqtts://hooks.example.com', 'webhook', policy('', PUBLIC))).ok).toBe(false);
  });
});

describe('checkTarget — allowed targets', () => {
  it('public https, pinned to the first answer, TLS name kept', async () => {
    const result = await checkTarget('https://hooks.example.com/hook', 'webhook', policy('', PUBLIC));
    expect(result).toEqual({ ok: true, host: 'hooks.example.com', port: 443, address: '93.184.216.34', tls: true });
  });

  it('a private target and plain http when the allowlist names it', async () => {
    const allowed = policy('10.20.0.0/16');
    expect(await checkTarget('http://10.20.1.5:8080/hook', 'webhook', allowed)).toMatchObject({ ok: true, address: '10.20.1.5', tls: false });
    expect((await checkTarget('http://10.30.1.5:8080/hook', 'webhook', allowed)).ok).toBe(false);
  });

  it('an allow entry with a port covers only that port', async () => {
    const allowed = policy('10.20.1.5:8080');
    expect((await checkTarget('http://10.20.1.5:8080/', 'webhook', allowed)).ok).toBe(true);
    expect((await checkTarget('http://10.20.1.5:8081/', 'webhook', allowed)).ok).toBe(false);
  });

  it('a hostname allow entry covers what that host resolves to', async () => {
    const allowed = policy('mes.plant.local', { 'mes.plant.local': ['10.9.0.4'] });
    expect(await checkTarget('mqtt://mes.plant.local', 'mqtt', allowed)).toMatchObject({ ok: true, port: 1883, address: '10.9.0.4' });
  });

  it('a blocked port opens only when an allow entry names that port', async () => {
    expect((await checkTarget('http://10.0.0.7:502/', 'webhook', policy('10.0.0.0/8'))).ok).toBe(false);
    expect((await checkTarget('http://10.0.0.7:502/', 'webhook', policy('10.0.0.7:502'))).ok).toBe(true);
  });
});

describe('Important: DNS rebinding — the connection goes to the pinned address, not a second lookup', () => {
  it('pinnedLookup answers only the pinned address, single and all forms', async () => {
    const lookup = pinnedLookup('10.1.2.3');
    const single = await new Promise((resolve) => lookup('anything', {}, (_error, address) => resolve(address)));
    expect(single).toBe('10.1.2.3');
    const all = await new Promise((resolve) => lookup('anything', { all: true }, (_error, addresses) => resolve(addresses)));
    expect(all).toEqual([{ address: '10.1.2.3', family: 4 }]);
  });

  it('the webhook sender connects to the pinned IP even though the host name never resolves', async () => {
    const receiver = await startReceiver(() => ({ status: 204 }));
    try {
      // `rebind.invalid` cannot resolve (RFC 6761) — reaching the receiver proves no second lookup happened
      const outcome = await sendWebhook({ url: `http://rebind.invalid:${receiver.port}/hook`, address: '127.0.0.1', body: Buffer.from('{}'), headers: {} });
      expect(outcome.statusCode).toBe(204);
      expect(receiver.requests[0]!.headers.host).toBe(`rebind.invalid:${receiver.port}`);
    } finally {
      await receiver.close();
    }
  });
});
