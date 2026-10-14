/**
 * Building an AID.
 *
 * Important: the key is the **round trip** — `parseAid()` must read back what was built and get the same content.
 *    If building and reading disagree, you get "built it, but nothing is collected", and the UI cannot show why.
 */
import { buildAidSubmodel, parseAid, AidBuildError, type AidBuildInput } from '@aas/collector';
import type { Environment } from '@aas/core';
import { describe, expect, it } from 'vitest';

const input: AidBuildInput = {
  assetName: 'RollFormingMachine',
  iriBase: 'https://www.smart-factory.kr/ids',
  endpoint: 'opc.tcp://192.168.0.50:4840',
  tags: [
    { name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', key: 'D100', type: 'float', unit: 'rpm' },
    { name: 'AlarmActive', href: 'ns=1;s=Machine.AlarmActive', type: 'boolean' },
  ],
};

describe('AID building', () => {
  it('parseAid reads back what was built — a broken round trip means no collection', () => {
    const submodel = buildAidSubmodel(input);
    const environment = { submodels: [submodel] } as unknown as Environment;
    const parsed = parseAid(environment);

    expect(parsed).toHaveLength(1);
    const one = parsed[0]!;
    expect(one.protocol).toBe('OPCUA');
    expect(one.base).toBe('opc.tcp://192.168.0.50:4840');
    expect(one.properties).toHaveLength(2);

    const motor = one.properties.find((p) => p.name === 'MotorSpeed')!;
    expect(motor.href).toBe('ns=1;s=Machine.MotorSpeed');
    expect(motor.unit).toBe('rpm');
    expect(motor.type).toBe('float');
    expect(motor.key).toBe('D100');
    expect(motor.observable).toBe(true);
  });

  it('id and semanticId follow KOSMO conventions (own IRI, rule conflict 1)', () => {
    const submodel = buildAidSubmodel(input) as { id: string; semanticId: { keys: { value: string }[] } };
    expect(submodel.id).toBe(
      'https://www.smart-factory.kr/ids/sm/RollFormingMachine/AssetInterfacesDescription/1/0',
    );
    expect(submodel.semanticId.keys[0]!.value).toBe(submodel.id);
  });

  it('every element gets an IDTA standard semanticId — missing ones flood KOSMO-SME-3', () => {
    const text = JSON.stringify(buildAidSubmodel(input));
    expect(text).toContain('https://www.w3.org/2019/wot/td#baseURI');
    expect(text).toContain('https://www.w3.org/2019/wot/hypermedia#hasTarget');
    expect(text).toContain('https://admin-shell.io/idta/AssetInterfaceDescription/1/0/PropertyDefinition');
  });

  it('stops on invalid input before building — a wrong AID makes the cause untraceable', () => {
    expect(() => buildAidSubmodel({ ...input, endpoint: 'http://x' })).toThrow(/opc\.tcp/);
    expect(() => buildAidSubmodel({ ...input, tags: [] })).toThrow(/하나도 없습니다/);
    expect(() =>
      buildAidSubmodel({ ...input, tags: [{ name: '모터속도', href: 'ns=1;s=x' }] }),
    ).toThrow(/영문/);
    expect(() =>
      buildAidSubmodel({
        ...input,
        tags: [
          { name: 'A', href: 'ns=1;s=x' },
          { name: 'A', href: 'ns=1;s=y' },
        ],
      }),
    ).toThrow(/겹칩니다/);
    expect(() =>
      buildAidSubmodel({ ...input, tags: [{ name: 'A', href: '' }] }),
    ).toThrow(/비었습니다/);
    // A call with no href at all (direct API use) — previously caused a 500 via TypeError
    expect(() =>
      buildAidSubmodel({ ...input, tags: [{ name: 'A' } as never] }),
    ).toThrow(AidBuildError);
    expect(() =>
      buildAidSubmodel({ ...input, tags: [{ name: 'A', href: 'x', type: 'double' }] }),
    ).toThrow(AidBuildError);
  });

  it('skips the element when key or unit is missing — never writes empty values', () => {
    const submodel = buildAidSubmodel({
      ...input,
      tags: [{ name: 'State', href: 'ns=1;s=State' }],
    });
    const text = JSON.stringify(submodel);
    expect(text).not.toContain('"idShort":"key"');
    expect(text).not.toContain('unitCode');
  });
});

describe('AID building — Modbus TCP / MQTT (2026-10-14)', () => {
  const base = { assetName: 'PressMachine', iriBase: 'https://www.smart-factory.kr/ids' };

  it('Modbus — includes interface name and form fields (modv_*), and parseAid reads them back', () => {
    const submodel = buildAidSubmodel({
      ...base,
      endpoint: 'modbus+tcp://192.168.0.20:502/1',
      tags: [
        { name: 'Counter', href: '40', form: { modv_entity: 'HoldingRegister', modv_type: 'xsd:unsignedShort' } },
        { name: 'Running', href: '1/5', form: { modv_function: 'readCoil' } },
      ],
    });
    const [descriptor] = parseAid({ submodels: [submodel] } as never);
    expect(descriptor).toMatchObject({ name: 'InterfaceTemplateForModbus', protocol: 'MODBUS', base: 'modbus+tcp://192.168.0.20:502/1' });
    expect(descriptor!.properties[0]).toMatchObject({ href: '40', formFields: { modv_entity: 'HoldingRegister', modv_type: 'xsd:unsignedShort' } });
    expect(descriptor!.properties[1]!.formFields).toEqual({ modv_function: 'readCoil' });
  });

  it('MQTT — includes the topic address and mqv_* fields', () => {
    const submodel = buildAidSubmodel({ ...base, endpoint: 'mqtt://broker.local:1883', tags: [{ name: 'Temp', href: 'plant/press/temp', form: { mqv_controlPacket: 'subscribe' } }] });
    const [descriptor] = parseAid({ submodels: [submodel] } as never);
    expect(descriptor).toMatchObject({ name: 'InterfaceTemplateForMQTT', protocol: 'MQTT' });
    expect(descriptor!.properties[0]).toMatchObject({ href: 'plant/press/temp', formFields: { mqv_controlPacket: 'subscribe' } });
  });

  it('stops on invalid input before building — other-protocol form fields, values, address shape, wildcards', () => {
    const modbus = (tag: AidBuildInput['tags'][number]) => () => buildAidSubmodel({ ...base, endpoint: 'modbus+tcp://h', tags: [tag] });
    expect(modbus({ name: 'A', href: '40', form: { mqv_qos: '0' } })).toThrow(AidBuildError);
    expect(modbus({ name: 'A', href: '40', form: { modv_entity: 'Register' } })).toThrow(/modv_entity/);
    expect(modbus({ name: 'A', href: 'ns=1;s=X' })).toThrow(/Modbus 주소/);
    expect(() => buildAidSubmodel({ ...base, endpoint: 'mqtt://h', tags: [{ name: 'A', href: 'plant/+/temp' }] })).toThrow(/와일드카드/);
    expect(() => buildAidSubmodel({ ...base, endpoint: 'http://h', tags: [{ name: 'A', href: 'x' }] })).toThrow(/modbus\+tcp/);
    // Modbus fields are not allowed on OPC UA
    expect(() => buildAidSubmodel({ ...base, endpoint: 'opc.tcp://h:4840', tags: [{ name: 'A', href: 'ns=1;s=X', form: { modv_type: 'xsd:int' } }] })).toThrow(AidBuildError);
  });
});
