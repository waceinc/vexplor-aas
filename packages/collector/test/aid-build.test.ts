/**
 * AID 만들기.
 *
 * 🔴 핵심은 **왕복**이다 — 만든 것을 `parseAid()`가 도로 읽어 같은 내용이 나와야 한다.
 *    만들기와 읽기가 어긋나면 "만들었는데 수집이 안 된다"가 되고, 화면에서는 원인을 알 수 없다.
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

describe('AID 만들기', () => {
  it('🔴 만든 것을 parseAid가 도로 읽는다 — 왕복이 어긋나면 수집이 안 된다', () => {
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

  it('id·semanticId가 KOSMO 규약을 따른다 (자체 IRI, 규정 충돌 ①)', () => {
    const submodel = buildAidSubmodel(input) as { id: string; semanticId: { keys: { value: string }[] } };
    expect(submodel.id).toBe(
      'https://www.smart-factory.kr/ids/sm/RollFormingMachine/AssetInterfacesDescription/1/0',
    );
    expect(submodel.semanticId.keys[0]!.value).toBe(submodel.id);
  });

  it('요소마다 IDTA 표준 semanticId가 붙는다 — 빠지면 KOSMO-SME-3이 쏟아진다', () => {
    const text = JSON.stringify(buildAidSubmodel(input));
    expect(text).toContain('https://www.w3.org/2019/wot/td#baseURI');
    expect(text).toContain('https://www.w3.org/2019/wot/hypermedia#hasTarget');
    expect(text).toContain('https://admin-shell.io/idta/AssetInterfaceDescription/1/0/PropertyDefinition');
  });

  it('🔴 틀린 입력은 만들기 전에 멈춘다 — 틀린 AID를 만들면 원인을 찾을 수 없다', () => {
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
    // href가 아예 없는 호출(API 직접) — 예전엔 TypeError로 500이 났다
    expect(() =>
      buildAidSubmodel({ ...input, tags: [{ name: 'A' } as never] }),
    ).toThrow(AidBuildError);
    expect(() =>
      buildAidSubmodel({ ...input, tags: [{ name: 'A', href: 'x', type: 'double' }] }),
    ).toThrow(AidBuildError);
  });

  it('key·unit이 없으면 그 요소를 만들지 않는다 — 빈 값을 넣지 않는다', () => {
    const submodel = buildAidSubmodel({
      ...input,
      tags: [{ name: 'State', href: 'ns=1;s=State' }],
    });
    const text = JSON.stringify(submodel);
    expect(text).not.toContain('"idShort":"key"');
    expect(text).not.toContain('unitCode');
  });
});
