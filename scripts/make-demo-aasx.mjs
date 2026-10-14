/**
 * Builds the AASX for the data-collection demo — golden file + AID submodel.
 *
 * The AID semanticIds are **taken verbatim from the official IDTA template (IDTA-02017-1-0).**
 * Built by hand, the standard terms each element needs go missing and KOSMO-SME-3 fires once per element
 * (a pitfall hit in practice — see docs/rules/README.md).
 *
 * Usage: node scripts/make-demo-aasx.mjs [opc.tcp address]
 * Output: out/demo/롤포밍기-수집시연.aasx
 */
import { readAasx, writeAasx } from '@aas/aasx';
import { ALL_RULES, lint } from '@aas/linter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const endpoint = process.argv[2] ?? 'opc.tcp://127.0.0.1:14840/UA/RollFormingMachine';

/** semanticIds extracted from the IDTA-02017-1-0 template */
const AID = {
  submodel: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel',
  interface: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Interface',
  endpointMetadata: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/EndpointMetadata',
  base: 'https://www.w3.org/2019/wot/td#baseURI',
  contentType: 'https://www.w3.org/2019/wot/hypermedia#forContentType',
  interactionMetadata: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/InteractionMetadata',
  properties: 'https://www.w3.org/2019/wot/td#PropertyAffordance',
  propertyDefinition: 'https://admin-shell.io/idta/AssetInterfaceDescription/1/0/PropertyDefinition',
  key: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/key',
  type: 'https://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  title: 'https://www.w3.org/2019/wot/td#title',
  observable: 'https://www.w3.org/2019/wot/td#isObservable',
  unit: 'https://schema.org/unitCode',
  forms: 'https://www.w3.org/2019/wot/td#hasForm',
  href: 'https://www.w3.org/2019/wot/hypermedia#hasTarget',
};

const ref = (value) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value }] });
const smc = (idShort, semantic, value) => ({
  modelType: 'SubmodelElementCollection',
  idShort,
  semanticId: ref(semantic),
  value,
});
const prop = (idShort, semantic, value) => ({
  modelType: 'Property',
  idShort,
  semanticId: ref(semantic),
  valueType: 'xs:string',
  value,
});

/** Virtual PLC tags — switching to real hardware only requires changing href */
const TAGS = [
  { name: 'MotorSpeed', key: 'D100', type: 'float', unit: 'rpm', node: 'ns=1;s=Machine.MotorSpeed' },
  { name: 'LineSpeed', key: 'D102', type: 'float', unit: 'm/min', node: 'ns=1;s=Machine.LineSpeed' },
  { name: 'MotorTemperature', key: 'D110', type: 'float', unit: 'Cel', node: 'ns=1;s=Machine.MotorTemperature' },
  { name: 'ProductionCount', key: 'D120', type: 'integer', unit: 'ea', node: 'ns=1;s=Machine.ProductionCount' },
  { name: 'AlarmActive', key: 'M20', type: 'boolean', node: 'ns=1;s=Machine.AlarmActive' },
  { name: 'MachineState', key: 'D130', type: 'string', node: 'ns=1;s=Machine.MachineState' },
  { name: 'BrokenSensor', key: 'D199', type: 'float', unit: 'Cel', node: 'ns=1;s=Machine.BrokenSensor' },
];

const pkg = readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')));
const shell = pkg.environment.assetAdministrationShells[0];
const assetName = shell.idShort;
const id = `https://www.smart-factory.kr/ids/sm/${assetName}/AssetInterfacesDescription/1/0`;

const aid = {
  modelType: 'Submodel',
  id,
  idShort: 'AssetInterfacesDescription',
  kind: 'Template',
  administration: { version: '1', revision: '0' },
  // Important: KOSMO rejects admin-shell.io IRIs, so the submodel's own id is used (rule conflict (1)).
  // The comment below stands in for the original value — the same role as the relocation ledger
  semanticId: ref(id),
  submodelElements: [
    smc('InterfaceTemplateForOPCUA', AID.interface, [
      prop('title', AID.title, `${assetName} 제어반 (OPC UA)`),
      smc('EndpointMetadata', AID.endpointMetadata, [
        prop('base', AID.base, endpoint),
        prop('contentType', AID.contentType, 'application/json'),
      ]),
      smc('InteractionMetadata', AID.interactionMetadata, [
        smc(
          'properties',
          AID.properties,
          TAGS.map((tag) =>
            // In AID the property's idShort is the item's name (the property_name slot in the official template)
            smc(tag.name, AID.propertyDefinition, [
              prop('key', AID.key, tag.key),
              prop('type', AID.type, tag.type),
              prop('title', AID.title, tag.name),
              prop('observable', AID.observable, 'true'),
              ...(tag.unit ? [prop('unit', AID.unit, tag.unit)] : []),
              smc('forms', AID.forms, [prop('href', AID.href, tag.node)]),
            ]),
          ),
        ),
      ]),
    ]),
  ],
};

pkg.environment.submodels.push(aid);
shell.submodels.push({ type: 'ModelReference', keys: [{ type: 'Submodel', value: id }] });

mkdirSync('out/demo', { recursive: true });
const out = 'out/demo/롤포밍기-수집시연.aasx';
writeFileSync(out, writeAasx(pkg));

const result = lint(pkg.environment, ALL_RULES, { package: pkg.opc });
console.log(`만들었습니다: ${out}`);
console.log(`  접속 주소: ${endpoint}`);
console.log(`  수집 태그: ${TAGS.length}개 (그중 BrokenSensor는 일부러 고장 낸 것)`);
console.log(`  규칙 검사: 위반 ${result.countBySeverity.error}건 · 경고 ${result.countBySeverity.warning}건`);
for (const finding of result.findings.filter((f) => f.severity === 'error').slice(0, 5)) {
  console.log(`    - ${finding.ruleId} ${finding.key}: ${finding.message.slice(0, 70)}`);
}
