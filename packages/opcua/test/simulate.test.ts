/**
 * 가상 PLC 태그 설계 — 어느 설비 AASX든 운전 데이터 이름대로 태그가 나오는가.
 * 🔴 태그 이름이 모델 idShort와 같아야 「수집 연결 만들기」가 모델 자리에 그대로 잇는다.
 */
import { readAasx } from '@aas/aasx';
import { simulationPlan, valueRule } from '@aas/opcua';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const spr = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/03-SPR장비-뿌80.aasx'))).environment;

describe('simulationPlan', () => {
  it('설비 이름으로 오브젝트를 만들고 OperationalData의 Property마다 태그를 둔다', () => {
    const plan = simulationPlan(spr());
    expect(plan.name).toBe('SPREquipment');
    expect(plan.tags.length).toBeGreaterThan(0);
    expect(plan.tags.every((tag) => tag.path.startsWith('OperationalData/'))).toBe(true);
    expect(plan.tags.map((tag) => tag.name)).toContain('MachineState');
  });

  it('NodeId는 설비 안에서 겹치지 않는다', () => {
    const ids = simulationPlan(spr()).tags.map((tag) => tag.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('같은 이름이 둘이면 NodeId에 번호를 붙이고 이름은 그대로 둔다', () => {
    const prop = { modelType: 'Property', idShort: 'Temp', valueType: 'xs:double', value: '20' };
    const plan = simulationPlan({
      assetAdministrationShells: [{ idShort: 'M' }],
      submodels: [
        {
          idShort: 'OperationalData',
          submodelElements: [
            { modelType: 'SubmodelElementCollection', idShort: 'A', value: [prop] },
            { modelType: 'SubmodelElementCollection', idShort: 'B', value: [prop] },
          ],
        },
      ],
    });
    expect(plan.tags.map((t) => t.nodeId)).toEqual(['M.Temp', 'M.Temp_2']);
    expect(plan.tags.map((t) => t.name)).toEqual(['Temp', 'Temp']);
  });
});

describe('valueRule', () => {
  it('상태는 알람 창(40초 중 5초)에서만 ALARM', () => {
    const rule = valueRule('MachineState', 'String', 'RUNNING');
    expect(rule(2)).toBe('ALARM');
    expect(rule(20)).toBe('RUNNING');
  });

  it('…Status는 가동상태로 흉내 내지 않는다 — 예시값 그대로', () => {
    expect(valueRule('RollWearStatus', 'String', 'Normal')(2)).toBe('Normal');
  });

  it('누적·카운트는 시간에 따라 줄지 않는다', () => {
    for (const [name, type] of [['CycleCount', 'Int32'], ['CumulativeEnergy', 'Double']] as const) {
      const rule = valueRule(name, type, '100');
      expect(Number(rule(100))).toBeGreaterThanOrEqual(Number(rule(10)));
      expect(Number(rule(10))).toBeGreaterThanOrEqual(100);
    }
  });

  it('불량 수는 생산 수보다 열 배 느리게 는다 — 양품률이 말이 되게', () => {
    const cycle = valueRule('CycleCount', 'Int32', '0');
    const ng = valueRule('NGCount', 'Int32', '0');
    expect(Number(cycle(300))).toBe(100);
    expect(Number(ng(300))).toBe(10);
    expect(Number(valueRule('DefectCount', 'Int32', '0')(300))).toBe(10);
    // 이름에 count가 있어도 불량이 아니면 종전대로
    expect(Number(valueRule('SocketCycleCount', 'Int32', '0')(300))).toBe(100);
  });

  it('그 밖의 수는 예시값 ±3% 안에서 흔들린다', () => {
    const rule = valueRule('SettingForce', 'Double', '60');
    for (const t of [0, 5, 13, 29]) {
      const v = Number(rule(t));
      expect(v).toBeGreaterThanOrEqual(58.2);
      expect(v).toBeLessThanOrEqual(61.8);
    }
  });

  it('판정은 대부분 OK, 가끔 NG', () => {
    const rule = valueRule('JudgmentResult', 'String', 'OK');
    const values = Array.from({ length: 30 }, (_, i) => rule(i * 3));
    expect(values.filter((v) => v === 'NG').length).toBe(3);
  });
});
