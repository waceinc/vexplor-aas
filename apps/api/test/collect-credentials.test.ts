/**
 * MQTT login without a password in the AAS (2.8.0). Before, the only way to log in to a broker was
 * `mqtt://user:password@host`, so the password was stored in the equipment file and handed out in the edge read list.
 * Now the AID only says a login is needed; the server's own collector takes the pair from its credentials file
 * (OPCUA_CLIENT_CREDENTIALS, keyed by address) and the edge read list names it (`credentialRef`) without carrying it.
 */
import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import type { Environment } from '@aas/core';
import { createHttpServer } from '@aas/api';
import { MqttTestBroker } from '@aas/fieldbus';
import { ALL_RULES, lint } from '@aas/linter';
import { InMemoryStore } from '@aas/store';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { interfacesOf } from '../src/edge/read-list.js';

const golden = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')));
const iriBase = 'https://www.smart-factory.kr/ids';
const tags = [{ name: 'Temperature', href: 'plant/m1/temp', type: 'float' }];

function withAid(endpoint: string, login: boolean): Environment {
  const pkg = golden();
  const aid = buildAidSubmodel({ assetName: 'M', iriBase, endpoint: 'mqtt://broker.local:1883', tags, ...(login ? { security: { login: true } } : {}) }) as never as { submodelElements: { value: { idShort: string; value: { idShort: string; value: string }[] }[] }[] };
  // Put the endpoint in afterwards — the builder refuses a user name in the address, an old file may still have one
  const endpointMetadata = aid.submodelElements[0]!.value.find((element) => element.idShort === 'EndpointMetadata')!;
  endpointMetadata.value.find((element) => element.idShort === 'base')!.value = endpoint;
  pkg.environment.submodels!.push(aid as never);
  return pkg.environment;
}

describe('edge read list — MQTT login', () => {
  it('names the address as credential and carries no secret', () => {
    const [iface] = interfacesOf('pkg_1', withAid('mqtt://broker.local:1883', true), 1000);
    expect(iface!.security).toEqual({ mode: 'None', credentialRef: 'mqtt://broker.local:1883' });
  });

  it('leaves out an interface whose address carries a user name and password — it would hand the secret out', () => {
    expect(interfacesOf('pkg_1', withAid('mqtt://aas:secret@broker.local:1883', false), 1000)).toEqual([]);
    expect(JSON.stringify(interfacesOf('pkg_1', withAid('mqtt://aas:secret@broker.local:1883', false), 1000))).not.toContain('secret');
  });

  it('the linter warns about a password in an AID address (AID-1)', () => {
    const findings = lint(withAid('mqtt://aas:secret@broker.local:1883', false), ALL_RULES).findings.filter((finding) => finding.ruleId === 'AID-1');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.message).not.toContain('secret');
    expect(lint(withAid('mqtt://broker.local:1883', true), ALL_RULES).findings.filter((finding) => finding.ruleId === 'AID-1')).toEqual([]);
  });
});

describe("the server's own collector — MQTT login from the credentials file", () => {
  let broker: MqttTestBroker | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  const saved = process.env['OPCUA_CLIENT_CREDENTIALS'];
  afterEach(async () => {
    await broker?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (saved === undefined) delete process.env['OPCUA_CLIENT_CREDENTIALS'];
    else process.env['OPCUA_CLIENT_CREDENTIALS'] = saved;
  });

  it('reads a broker that wants a login, with the pair from the file and an address without it', async () => {
    broker = new MqttTestBroker({ username: 'aas', password: 'secret' });
    const port = await broker.listen();
    broker.publish('plant/m1/temp', '36.6', true);
    const endpoint = `mqtt://127.0.0.1:${port}`;
    const file = join(mkdtempSync(join(tmpdir(), 'cred-')), 'credentials.json');
    writeFileSync(file, JSON.stringify({ [endpoint]: { userName: 'aas', password: 'secret' } }));
    process.env['OPCUA_CLIENT_CREDENTIALS'] = file;

    const store = new InMemoryStore();
    await store.init();
    const id = (await store.importPackage({ name: 'm.aasx', package: golden() })).id;
    server = createHttpServer({ store, collect: true });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body?: unknown) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

    const made = await post(`/packages/${id}/aid`, { endpoint, security: { login: true }, tags });
    expect(made.status).toBe(201);
    const collected = (await (await post(`/packages/${id}/collect`)).json()) as { interfaces: { error?: string; report?: { collected: number } }[] };
    expect(collected.interfaces[0]!.error).toBeUndefined();
    expect(collected.interfaces[0]!.report!.collected).toBe(1);
    expect(JSON.stringify(await store.getEnvironment(id))).not.toContain('secret');
  });
});

describe('edge read list — the read period the AID states (2.8.0)', () => {
  it('is the interface interval when every tag states the same one', () => {
    const pkg = golden();
    pkg.environment.submodels!.push(buildAidSubmodel({ assetName: 'M', iriBase, endpoint: 'modbus+tcp://10.0.0.5:502/1', intervalMs: 2000, tags: [{ name: 'A', href: '40' }, { name: 'B', href: '41' }] }) as never);
    const [iface] = interfacesOf('pkg_1', pkg.environment, 5000);
    expect(iface!.intervalMs).toBe(2000);
    expect(iface!.tags.every((tag) => tag.intervalMs === undefined)).toBe(true);
  });

  it('stays the server default when the AID states none', () => {
    const pkg = golden();
    pkg.environment.submodels!.push(buildAidSubmodel({ assetName: 'M', iriBase, endpoint: 'modbus+tcp://10.0.0.5:502/1', tags: [{ name: 'A', href: '40' }] }) as never);
    expect(interfacesOf('pkg_1', pkg.environment, 5000)[0]!.intervalMs).toBe(5000);
  });
});
