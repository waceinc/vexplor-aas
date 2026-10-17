import { readFileSync } from 'node:fs';
import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { describe, expect, it } from 'vitest';
import { aidReadList } from '../src/integration/bundle-build.js';
import { revisionOf } from '../src/edge/read-list.js';
import { ROLE_HINTS } from '../src/edge/tag-hints.js';

const IRI = (name: string): string => `https://www.smart-factory.kr/ids/cd/${name}/1/0`;

/** A fixture with an AID whose tags are named after its OperationalData properties (as the virtual PLC does) */
function withAid(fixture: string, assetName: string, names: string[]) {
  const pkg = readAasx(new Uint8Array(readFileSync(`tests/fixtures/${fixture}`)));
  pkg.environment.submodels!.push(
    buildAidSubmodel({
      assetName,
      iriBase: 'https://www.smart-factory.kr/ids',
      endpoint: 'opc.tcp://192.168.10.21:4840',
      tags: names.map((name) => ({ name, href: `ns=2;s=Machine.${name}`, type: 'float' })),
    }) as never,
  );
  return pkg.environment;
}

const tagsOf = (environment: ReturnType<typeof withAid>) =>
  new Map(aidReadList(environment, 'pkg_1', 1000).flatMap((iface) => iface.tags.map((tag) => [tag.propertyName, tag] as const)));

describe('read-list tag hints', () => {
  it('names the semanticId of the model element and suggests a role from it', () => {
    const tags = tagsOf(withAid('01-roll-forming-machine.aasx', 'RollFormingMachine', ['MachineState', 'CumulativeLength', 'AlarmActive', 'CumulativeRunHours', 'RollWearStatus', 'MaterialYieldRate', 'FormingForce']));
    expect(tags.get('MachineState')).toMatchObject({ semanticId: IRI('MachineState'), suggestedRole: 'run_state' });
    expect(tags.get('CumulativeLength')).toMatchObject({ semanticId: IRI('CumulativeLength'), suggestedRole: 'counter' });
    expect(tags.get('AlarmActive')).toMatchObject({ suggestedRole: 'alarm_source' });
    expect(tags.get('CumulativeRunHours')).toMatchObject({ suggestedRole: 'meter' });
    expect(tags.get('RollWearStatus')).toMatchObject({ suggestedRole: 'condition' });
    expect(tags.get('MaterialYieldRate')).toMatchObject({ suggestedRole: 'quality' });
    // In the model, but in no role table — a value
    expect(tags.get('FormingForce')).toMatchObject({ semanticId: IRI('FormingForce'), suggestedRole: 'value' });
  });

  it('a property that resolves to no model element gets no semanticId and the role value', () => {
    const tags = tagsOf(withAid('01-roll-forming-machine.aasx', 'RollFormingMachine', ['SpindleSpeed']));
    expect(tags.get('SpindleSpeed')!.semanticId).toBeUndefined();
    expect(tags.get('SpindleSpeed')!.suggestedRole).toBe('value');
  });

  it('pairs a measured value with every limit of the same file, each with its source', () => {
    const spr = tagsOf(withAid('03-spr-riveting-machine.aasx', 'SPREquipment', ['SettingForce', 'CycleCount']));
    expect(spr.get('SettingForce')!.limits).toEqual([
      { bound: 'usl', value: 80, semanticId: IRI('MaxSettingForce'), source: expect.stringMatching(/^TechnicalData:.*MaxSettingForce$/) },
    ]);
    expect(spr.get('CycleCount')).toMatchObject({ suggestedRole: 'counter' });
    expect(spr.get('CycleCount')!.limits).toBeUndefined();
    // A performance limit and a safety limit for the same value — both listed, the receiver picks
    const line = tagsOf(withAid('01-roll-forming-machine.aasx', 'RollFormingMachine', ['CurrentLineSpeed']));
    expect(line.get('CurrentLineSpeed')!.limits!.map((limit) => [limit.semanticId, limit.value])).toEqual([
      [IRI('MaxFormingSpeed'), 30],
      [IRI('MaxSafeLineSpeed'), 35],
    ]);
  });

  it('hints are left out of the revision — adding them never asks a site to approve again', () => {
    const interfaces = aidReadList(withAid('01-roll-forming-machine.aasx', 'RollFormingMachine', ['MachineState', 'CurrentLineSpeed']), 'pkg_1', 1000);
    const bare = interfaces.map((iface) => ({
      ...iface,
      tags: iface.tags.map(({ tagId, propertyName, address, key, type, unit, fields }) => ({
        tagId, propertyName, address, fields, ...(key !== undefined ? { key } : {}), ...(type !== undefined ? { type } : {}), ...(unit !== undefined ? { unit } : {}),
      })),
    }));
    expect(interfaces[0]!.tags.some((tag) => tag.suggestedRole === 'run_state')).toBe(true);
    expect(revisionOf(interfaces)).toBe(revisionOf(bare));
  });

  it('the role table holds no semanticId twice', () => {
    const all = ROLE_HINTS.flatMap((hint) => hint.semanticIds);
    expect(new Set(all).size).toBe(all.length);
  });
});
