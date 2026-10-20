import { readFileSync } from 'node:fs';
import type { Environment } from '@aas/core';
import { parseEnvironmentXml, readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { describe, expect, it } from 'vitest';
import { aidReadList } from '../src/integration/bundle-build.js';

/**
 * Range elements as lsl / usl hints (docs/edge-contract.md §4.1). None of the shipped fixtures holds a Range, so the
 * tests add one in memory; names are invented (CONTRIBUTING rule 4).
 */
const IRI = (name: string): string => `https://www.smart-factory.kr/ids/cd/${name}/1/0`;

const range = (idShort: string, semanticId: string | undefined, bounds: { min?: string; max?: string }) => ({
  modelType: 'Range',
  idShort,
  valueType: 'xs:double',
  ...(semanticId === undefined ? {} : { semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: semanticId }] } }),
  ...bounds,
});

function addAid(environment: Environment, assetName: string, names: string[]): Environment {
  environment.submodels!.push(
    buildAidSubmodel({
      assetName,
      iriBase: 'https://www.smart-factory.kr/ids',
      endpoint: 'opc.tcp://192.168.10.21:4840',
      tags: names.map((name) => ({ name, href: `ns=2;s=Machine.${name}`, type: 'float' })),
    }) as never,
  );
  return environment;
}

/** A fixture with extra elements in its TechnicalData submodel and an AID for the named tags */
function fixtureWith(fixture: string, assetName: string, extra: unknown[], names: string[]): Environment {
  const environment = readAasx(new Uint8Array(readFileSync(`tests/fixtures/${fixture}`))).environment;
  const technical = environment.submodels!.find((submodel) => submodel.idShort === 'TechnicalData')!;
  technical.submodelElements!.push(...(extra as never[]));
  return addAid(environment, assetName, names);
}

const tagsOf = (environment: Environment) =>
  new Map(aidReadList(environment, 'pkg_1', 1000).flatMap((iface) => iface.tags.map((tag) => [tag.propertyName, tag] as const)));

describe('read-list tag hints — Range elements', () => {
  it('a Range with the same semanticId gives lsl and usl, after the property pairs', () => {
    const tags = tagsOf(fixtureWith('01-roll-forming-machine.aasx', 'RollFormingMachine', [range('LineSpeedBand', IRI('CurrentLineSpeed'), { min: '5', max: '28' })], ['CurrentLineSpeed']));
    expect(tags.get('CurrentLineSpeed')!.limits).toEqual([
      expect.objectContaining({ bound: 'usl', value: 30, semanticId: IRI('MaxFormingSpeed') }),
      expect.objectContaining({ bound: 'usl', value: 35, semanticId: IRI('MaxSafeLineSpeed') }),
      { bound: 'lsl', value: 5, semanticId: IRI('CurrentLineSpeed'), source: 'TechnicalData:LineSpeedBand' },
      { bound: 'usl', value: 28, semanticId: IRI('CurrentLineSpeed'), source: 'TechnicalData:LineSpeedBand' },
    ]);
  });

  it('min only gives lsl only, max only gives usl only', () => {
    const tags = tagsOf(
      fixtureWith('01-roll-forming-machine.aasx', 'RollFormingMachine', [
        range('ForceFloor', IRI('FormingForce'), { min: '2.5' }),
        range('YieldCeiling', IRI('MaterialYieldRate'), { max: '99.5' }),
      ], ['FormingForce', 'MaterialYieldRate']),
    );
    expect(tags.get('FormingForce')!.limits).toEqual([{ bound: 'lsl', value: 2.5, semanticId: IRI('FormingForce'), source: 'TechnicalData:ForceFloor' }]);
    expect(tags.get('MaterialYieldRate')!.limits).toEqual([{ bound: 'usl', value: 99.5, semanticId: IRI('MaterialYieldRate'), source: 'TechnicalData:YieldCeiling' }]);
  });

  it('a bound that is no number is left out; min above max gives nothing', () => {
    const tags = tagsOf(
      fixtureWith('01-roll-forming-machine.aasx', 'RollFormingMachine', [
        range('ForceBand', IRI('FormingForce'), { min: 'low', max: '12' }),
        range('YieldBand', IRI('MaterialYieldRate'), { min: '', max: ' ' }),
        range('LengthBand', IRI('CumulativeLength'), { min: '30', max: '10' }),
      ], ['FormingForce', 'MaterialYieldRate', 'CumulativeLength']),
    );
    expect(tags.get('FormingForce')!.limits).toEqual([{ bound: 'usl', value: 12, semanticId: IRI('FormingForce'), source: 'TechnicalData:ForceBand' }]);
    expect(tags.get('MaterialYieldRate')!.limits).toBeUndefined();
    expect(tags.get('CumulativeLength')!.limits).toBeUndefined();
  });

  it('a Range is never matched by its name or by sitting next to the value', () => {
    const tags = tagsOf(
      fixtureWith('01-roll-forming-machine.aasx', 'RollFormingMachine', [
        range('FormingForceRange', undefined, { min: '1', max: '9' }),
        range('FormingForceLimits', IRI('OtherConcept'), { min: '1', max: '9' }),
      ], ['FormingForce']),
    );
    expect(tags.get('FormingForce')!.limits).toBeUndefined();
  });

  it('a tag that names a Range itself does not take that Range as its own limit', () => {
    const tags = tagsOf(fixtureWith('01-roll-forming-machine.aasx', 'RollFormingMachine', [range('SpeedBand', IRI('SpeedBandConcept'), { min: '1', max: '9' })], ['SpeedBand']));
    expect(tags.get('SpeedBand')).toMatchObject({ semanticId: IRI('SpeedBandConcept') });
    expect(tags.get('SpeedBand')!.limits).toBeUndefined();
  });

  it('a Range read from XML gives the same hints', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<environment xmlns="https://admin-shell.io/aas/3/0">
  <submodels>
    <submodel>
      <idShort>TechnicalData</idShort>
      <id>urn:example:sm:technical</id>
      <submodelElements>
        <property>
          <idShort>DrumSpeed</idShort>
          <semanticId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>${IRI('DrumSpeed')}</value></key></keys></semanticId>
          <valueType>xs:double</valueType>
          <value>12</value>
        </property>
        <range>
          <idShort>DrumSpeedBand</idShort>
          <semanticId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>${IRI('DrumSpeed')}</value></key></keys></semanticId>
          <valueType>xs:double</valueType>
          <min>4</min>
          <max>20</max>
        </range>
      </submodelElements>
    </submodel>
  </submodels>
</environment>`;
    const tags = tagsOf(addAid(parseEnvironmentXml(xml), 'Drum', ['DrumSpeed']));
    expect(tags.get('DrumSpeed')!.limits).toEqual([
      { bound: 'lsl', value: 4, semanticId: IRI('DrumSpeed'), source: 'TechnicalData:DrumSpeedBand' },
      { bound: 'usl', value: 20, semanticId: IRI('DrumSpeed'), source: 'TechnicalData:DrumSpeedBand' },
    ]);
  });

  it('files without a Range keep the hints they had — no lsl appears', () => {
    for (const [fixture, asset] of [['01-roll-forming-machine.aasx', 'RollFormingMachine'], ['01-roll-forming-machine-xml.aasx', 'RollFormingMachine'], ['03-spr-riveting-machine.aasx', 'SPREquipment'], ['11-cobot-6-axis.aasx', 'Cobot']] as const) {
      const environment = readAasx(new Uint8Array(readFileSync(`tests/fixtures/${fixture}`))).environment;
      const names = ['CurrentLineSpeed', 'SettingForce', 'TCPSpeed', 'FormingForce'];
      const limits = [...tagsOf(addAid(environment, asset, names)).values()].flatMap((tag) => tag.limits ?? []);
      expect(limits.every((limit) => limit.bound === 'usl'), fixture).toBe(true);
    }
  });
});
