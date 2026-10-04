/**
 * 수집값 읽기 전용 덧씌우기.
 *
 * 🔴 이 시험의 핵심은 두 가지다.
 *  ① 응답에는 현장 값이 보인다 (BaSyx DataBridge와 같은 겉모습)
 *  ② **원본은 그대로다** — A안(파일이 원본)이 깨지면 이 제품의 전제가 무너진다
 */
import { overlayEnvironment, overlaySubmodel, latestByProperty, type ValueSample } from '@aas/collector';
import { describe, expect, it } from 'vitest';

function sample(name: string, value: number | string, at: string): ValueSample {
  return {
    packageId: 'pkg_1',
    interfaceName: 'OPCUA',
    propertyName: name,
    observedAt: at,
    ...(typeof value === 'number' ? { valueNumber: value } : { valueText: value }),
    quality: 'Good',
  };
}

const submodel = {
  modelType: 'Submodel',
  id: 'https://example.com/sm/1',
  idShort: 'OperationalData',
  submodelElements: [
    {
      modelType: 'SubmodelElementCollection',
      idShort: 'ProcessMonitoring',
      value: [
        { modelType: 'Property', idShort: 'MachineState', valueType: 'xs:string', value: 'IDLE' },
        { modelType: 'Property', idShort: 'LineSpeed', valueType: 'xs:double', value: '0' },
      ],
    },
    { modelType: 'Property', idShort: 'AlarmActive', valueType: 'xs:boolean', value: 'false' },
  ],
} as never;

describe('덧씌우기', () => {
  it('최신 값만 쓴다 — 같은 이름이 여러 번 들어와도', () => {
    const latest = latestByProperty([
      sample('LineSpeed', 10, '2026-08-25T00:00:00Z'),
      sample('LineSpeed', 18.5, '2026-08-25T00:00:05Z'),
      sample('LineSpeed', 12, '2026-08-25T00:00:02Z'),
    ]);
    expect(latest.get('LineSpeed')?.valueNumber).toBe(18.5);
  });

  it('이름이 맞는 요소에 값을 얹는다 (깊은 곳도)', () => {
    const result = overlaySubmodel(submodel, [
      sample('MachineState', 'RUNNING', '2026-08-25T00:00:00Z'),
      sample('LineSpeed', 18.5, '2026-08-25T00:00:00Z'),
    ]);
    const collection = result.content.submodelElements![0] as never as { value: { value: string }[] };
    expect(collection.value[0]!.value).toBe('RUNNING');
    expect(collection.value[1]!.value).toBe('18.5');
    expect(result.applied).toBe(2);
  });

  it('🔴 원본은 건드리지 않는다 — A안(파일이 원본)', () => {
    const before = JSON.stringify(submodel);
    overlaySubmodel(submodel, [sample('MachineState', 'RUNNING', '2026-08-25T00:00:00Z')]);
    expect(JSON.stringify(submodel)).toBe(before);
  });

  it('못 찾은 값은 조용히 버리지 않고 알린다', () => {
    const result = overlaySubmodel(submodel, [sample('MotorSpeed', 1200, '2026-08-25T00:00:00Z')]);
    expect(result.applied).toBe(0);
    expect(result.notes[0]).toMatchObject({ propertyName: 'MotorSpeed', outcome: 'unmatched' });
  });

  it('🔴 이름이 겹치면 얹지 않는다 — 엉뚱한 요소에 현장 값이 들어가는 게 최악이다', () => {
    const twins = {
      modelType: 'Submodel',
      id: 'x',
      idShort: 'S',
      submodelElements: [
        { modelType: 'Property', idShort: 'Temp', valueType: 'xs:double', value: '1' },
        {
          modelType: 'SubmodelElementCollection',
          idShort: 'Group',
          value: [{ modelType: 'Property', idShort: 'Temp', valueType: 'xs:double', value: '2' }],
        },
      ],
    } as never;
    const result = overlaySubmodel(twins, [sample('Temp', 65, '2026-08-25T00:00:00Z')]);
    expect(result.applied).toBe(0);
    expect(result.notes[0]!.outcome).toBe('ambiguous');
    expect(result.notes[0]!.paths).toEqual(['Temp', 'Group.Temp']);
  });

  it('담는 요소에는 얹지 않는다', () => {
    const result = overlaySubmodel(submodel, [
      sample('ProcessMonitoring', 'x', '2026-08-25T00:00:00Z'),
    ]);
    expect(result.applied).toBe(0);
    expect(result.notes[0]!.outcome).toBe('unmatched');
  });

  it('환경 전체에도 얹을 수 있다', () => {
    const environment = { submodels: [submodel] } as never;
    const result = overlayEnvironment(environment, [
      sample('AlarmActive', 'true', '2026-08-25T00:00:00Z'),
    ]);
    expect(result.applied).toBe(1);
    const applied = result.content.submodels![0]!.submodelElements![1] as never as { value: string };
    expect(applied.value).toBe('true');
  });

  it('언제 읽은 값인지 함께 알려 준다', () => {
    const result = overlaySubmodel(submodel, [
      sample('AlarmActive', 'true', '2026-08-25T01:02:03Z'),
    ]);
    expect(result.notes[0]).toMatchObject({
      outcome: 'applied',
      observedAt: '2026-08-25T01:02:03Z',
      quality: 'Good',
    });
  });
});

describe('🔴 서브모델 경계를 넘는 이름 중복', () => {
  it('다른 서브모델에 같은 이름이 있으면 **어느 쪽에도 얹지 않는다**', () => {
    // 실제로 생길 수 있는 모습: 명판의 ManufacturerName과, 수집용으로 새로 세운 같은 이름
    const environment = {
      submodels: [
        {
          modelType: 'Submodel',
          id: 'sm-dn',
          idShort: 'DigitalNameplate',
          submodelElements: [
            { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: '알에프엠기계(주)' },
          ],
        },
        {
          modelType: 'Submodel',
          id: 'sm-od',
          idShort: 'OperationalData',
          submodelElements: [
            { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: 'N/A' },
          ],
        },
      ],
    } as unknown as Environment;

    const result = overlayEnvironment(environment, [
      {
        packageId: 'p',
        interfaceName: 'I',
        propertyName: 'ManufacturerName',
        observedAt: '2026-09-01T00:00:00.000Z',
        valueText: '엉뚱한값',
      },
    ] as never);

    // 🔴 명판 값이 수집값으로 덮이면 안 된다 — 이것이 「최악」으로 못박은 경우다
    expect(result.applied).toBe(0);
    expect(result.notes[0]!.outcome).toBe('ambiguous');
    expect(result.notes[0]!.paths).toHaveLength(2);
    const shown = JSON.stringify(result.content);
    expect(shown).toContain('알에프엠기계(주)');
    expect(shown).not.toContain('엉뚱한값');
  });

  it('겹친 자리가 어느 서브모델인지 말해 준다 — 안 그러면 찾아갈 수 없다', () => {
    const environment = {
      submodels: [
        { modelType: 'Submodel', id: 'a', idShort: 'DigitalNameplate',
          submodelElements: [{ modelType: 'Property', idShort: 'X', valueType: 'xs:string', value: '1' }] },
        { modelType: 'Submodel', id: 'b', idShort: 'OperationalData',
          submodelElements: [{ modelType: 'Property', idShort: 'X', valueType: 'xs:string', value: '2' }] },
      ],
    } as unknown as Environment;
    const result = overlayEnvironment(environment, [
      { packageId: 'p', interfaceName: 'I', propertyName: 'X',
        observedAt: '2026-09-01T00:00:00.000Z', valueText: 'v' },
    ] as never);
    expect(result.notes[0]!.paths).toEqual(['DigitalNameplate.X', 'OperationalData.X']);
  });
});
