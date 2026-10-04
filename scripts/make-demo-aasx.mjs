/**
 * 수집 시연용 AASX 만들기 — 골든 파일 + AID 서브모델.
 *
 * AID의 semanticId는 **IDTA 공식 템플릿(IDTA-02017-1-0)에서 그대로 가져왔다.**
 * 손으로 만들면 요소마다 붙어야 할 표준 용어가 빠져 KOSMO-SME-3이 요소 수만큼 뜬다
 * (실측으로 겪은 함정 — docs/rules/README.md 참조).
 *
 * 사용: node scripts/make-demo-aasx.mjs [opc.tcp 주소]
 * 결과: out/demo/롤포밍기-수집시연.aasx
 */
import { readAasx, writeAasx } from '@aas/aasx';
import { ALL_RULES, lint } from '@aas/linter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const endpoint = process.argv[2] ?? 'opc.tcp://127.0.0.1:14840/UA/RollFormingMachine';

/** IDTA-02017-1-0 템플릿에서 뽑은 semanticId */
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

/** 가상 PLC의 태그 — 실물로 바꿀 때는 href만 고치면 된다 */
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
  // 🔴 KOSMO는 admin-shell.io IRI를 거부하므로 자기 id를 쓴다(규정 충돌 ①).
  // 원래 값은 아래 주석이 대신한다 — 이관 대장과 같은 역할이다
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
            // AID에서 property의 idShort가 곧 그 항목의 이름이다(공식 템플릿의 property_name 자리)
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
