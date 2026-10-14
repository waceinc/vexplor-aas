/**
 * Virtual PLC tag design — for any device AASX, do tags come out named after its operational data?
 * Important: tag names must equal the model idShort so "Create collection link" connects them straight to their place in the model.
 */
import { readAasx } from '@aas/aasx';
import { simulationPlan, valueRule } from '@aas/opcua';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const spr = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/03-spr-riveting-machine.aasx'))).environment;

describe('simulationPlan', () => {
  it('creates an object named after the device and a tag per Property of OperationalData', () => {
    const plan = simulationPlan(spr());
    expect(plan.name).toBe('SPREquipment');
    expect(plan.tags.length).toBeGreaterThan(0);
    expect(plan.tags.every((tag) => tag.path.startsWith('OperationalData/'))).toBe(true);
    expect(plan.tags.map((tag) => tag.name)).toContain('MachineState');
  });

  it('NodeIds do not collide within a device', () => {
    const ids = simulationPlan(spr()).tags.map((tag) => tag.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('when two share a name, numbers the NodeId and keeps the name', () => {
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
  it('state is ALARM only in the alarm window (5 s of every 40 s)', () => {
    const rule = valueRule('MachineState', 'String', 'RUNNING');
    expect(rule(2)).toBe('ALARM');
    expect(rule(20)).toBe('RUNNING');
  });

  it('…Status is not simulated as machine state — sample value as is', () => {
    expect(valueRule('RollWearStatus', 'String', 'Normal')(2)).toBe('Normal');
  });

  it('cumulative values and counts never decrease over time', () => {
    for (const [name, type] of [['CycleCount', 'Int32'], ['CumulativeEnergy', 'Double']] as const) {
      const rule = valueRule(name, type, '100');
      expect(Number(rule(100))).toBeGreaterThanOrEqual(Number(rule(10)));
      expect(Number(rule(10))).toBeGreaterThanOrEqual(100);
    }
  });

  it('defect count grows ten times slower than production count — so the yield makes sense', () => {
    const cycle = valueRule('CycleCount', 'Int32', '0');
    const ng = valueRule('NGCount', 'Int32', '0');
    expect(Number(cycle(300))).toBe(100);
    expect(Number(ng(300))).toBe(10);
    expect(Number(valueRule('DefectCount', 'Int32', '0')(300))).toBe(10);
    // "count" in the name but not a defect -> unchanged behaviour
    expect(Number(valueRule('SocketCycleCount', 'Int32', '0')(300))).toBe(100);
  });

  it('other numbers fluctuate within ±3% of the sample value', () => {
    const rule = valueRule('SettingForce', 'Double', '60');
    for (const t of [0, 5, 13, 29]) {
      const v = Number(rule(t));
      expect(v).toBeGreaterThanOrEqual(58.2);
      expect(v).toBeLessThanOrEqual(61.8);
    }
  });

  it('judgement is mostly OK, occasionally NG', () => {
    const rule = valueRule('JudgmentResult', 'String', 'OK');
    const values = Array.from({ length: 30 }, (_, i) => rule(i * 3));
    expect(values.filter((v) => v === 'NG').length).toBe(3);
  });
});
