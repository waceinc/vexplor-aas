/**
 * What the "Create collection link" screen can now state (2.8.0): OPC UA channel security and a user name login,
 * MQTT login, and a read period — written as the AID states them and read back by parseAid (round trip).
 * Before, a link made on the screen was always OPC UA None and anonymous, and the read period was the server's.
 */
import { buildAidSubmodel, parseAid, pollingMsOf, statedIntervalMs, AidBuildError, type AidBuildInput } from '@aas/collector';
import { describe, expect, it } from 'vitest';

const base = { assetName: 'PressMachine', iriBase: 'https://www.smart-factory.kr/ids' };
const opcua: AidBuildInput = { ...base, endpoint: 'opc.tcp://192.168.0.50:4840', tags: [{ name: 'Speed', href: 'ns=1;s=Speed', type: 'float' }] };
const parsed = (input: AidBuildInput) => parseAid({ submodels: [buildAidSubmodel(input)] } as never)[0]!;

describe('AID security from the screen', () => {
  it('OPC UA Sign with a policy and a user name login — read back as the reader needs it', () => {
    expect(parsed({ ...opcua, security: { mode: 'Sign', policy: 'Basic256Sha256', login: true } }).security).toEqual({
      mode: 'Sign',
      policy: 'Basic256Sha256',
      userIdentityToken: 'UserName',
    });
    expect(parsed({ ...opcua, security: { mode: 'SignAndEncrypt', policy: 'Aes256_Sha256_RsaPss' } }).security).toEqual({ mode: 'SignAndEncrypt', policy: 'Aes256_Sha256_RsaPss' });
    expect(parsed({ ...opcua, security: { login: true } }).security).toEqual({ userIdentityToken: 'UserName' });
    expect(parsed({ ...opcua, security: { mode: 'None' } }).security).toBeUndefined();
  });

  it('refuses what the collector could not connect with', () => {
    expect(() => buildAidSubmodel({ ...opcua, security: { mode: 'Sign' } })).toThrow(/보안 정책/);
    expect(() => buildAidSubmodel({ ...opcua, security: { mode: 'Sign', policy: 'Basic128Rsa15' } })).toThrow(AidBuildError);
    expect(() => buildAidSubmodel({ ...base, endpoint: 'modbus+tcp://h/1', tags: [{ name: 'A', href: '40' }], security: { login: true } })).toThrow(/Modbus/);
    expect(() => buildAidSubmodel({ ...base, endpoint: 'mqtt://h', tags: [{ name: 'A', href: 'a/b' }], security: { mode: 'Sign', policy: 'Basic256Sha256' } })).toThrow(/OPC UA/);
  });
});

describe('AID read period from the screen', () => {
  it('Modbus states it with the binding term, OPC UA and MQTT with ours — every form, read back in ms', () => {
    const modbus = parsed({ ...base, endpoint: 'modbus+tcp://h/1', intervalMs: 2000, tags: [{ name: 'A', href: '40' }, { name: 'B', href: '41' }] });
    expect(modbus.properties.map((property) => property.formFields['modv_pollingTime'])).toEqual(['2000', '2000']);
    expect(statedIntervalMs(modbus)).toBe(2000);
    const ua = parsed({ ...opcua, intervalMs: 500 });
    expect(ua.properties[0]!.formFields['vxp_pollingTime']).toBe('500');
    expect(pollingMsOf(ua.properties[0]!)).toBe(500);
    expect(statedIntervalMs(parsed(opcua))).toBeUndefined();
  });

  it('refuses a period the edge approval would refuse (100 ms – 1 h, whole ms)', () => {
    expect(() => buildAidSubmodel({ ...opcua, intervalMs: 50 })).toThrow(/읽기 주기/);
    expect(() => buildAidSubmodel({ ...opcua, intervalMs: 1.5e3 + 0.5 })).toThrow(AidBuildError);
    expect(pollingMsOf({ formFields: { modv_pollingTime: '10' } })).toBeUndefined();
  });

  it('Modbus word and byte order, and units, go through as before', () => {
    const one = parsed({
      ...base,
      endpoint: 'modbus+tcp://h/1',
      tags: [{ name: 'Flow', href: '40', type: 'float', unit: 'L/min', form: { modv_type: 'xsd:float', modv_mostSignificantWord: 'false', modv_mostSignificantByte: 'true' } }],
    }).properties[0]!;
    expect(one.unit).toBe('L/min');
    expect(one.formFields).toMatchObject({ modv_mostSignificantWord: 'false', modv_mostSignificantByte: 'true' });
  });
});
