/**
 * 🔴 **자기 자신 훑기 차단** — 실제로 일어난 사고를 막는 자리.
 *
 * 사용자가 「설비 주소」에 우리 도구 자신의 OPC UA 주소를 넣고 훑었고, 우리가 내주던
 * AAS 내용(제조사명·일련번호 같은 명판 정보) 79개가 「수집할 태그」로 나왔다.
 * 화면이 그 동선을 만들고 있었다 — 내보내기 주소가 수집 조작부 바로 옆에 떠 있었다.
 *
 * 🔴 경고가 아니라 **차단**이다. 담아서 만들면 모델에 항목과 CD가 수십 개씩 서는데,
 *    「연결삭제」는 AID만 지운다 — 되돌릴 길이 없다.
 * 🔴 주소 문자열 비교로는 못 막는다. 호스트명·IP가 달라도 같은 서버다.
 *    그래서 **상대에게 물어본다**(applicationUri · productUri).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AasOpcUaServer, browseDevice, planForPackage, SelfBrowseError } from '../src/index.js';
import type { Environment } from '@aas/core';
import { startTestServer, type TestServer } from './server.js';

const environment = {
  assetAdministrationShells: [
    { modelType: 'AssetAdministrationShell', id: 'aas-1', idShort: '롤포밍기', assetInformation: { assetKind: 'Type' } },
  ],
  submodels: [
    {
      modelType: 'Submodel',
      id: 'https://ktl/sm/dn',
      idShort: 'DigitalNameplate',
      submodelElements: [
        { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: '알에프엠기계(주)' },
      ],
    },
  ],
} as unknown as Environment;

let ours: AasOpcUaServer;
let ourEndpoint: string;
let device: TestServer;

async function startOurs(port: number): Promise<void> {
  ours = new AasOpcUaServer({
    port,
    hostname: '127.0.0.1',
    load: async () => [planForPackage(environment, { packageId: 'pkg-1' })],
  });
  await ours.start();
  ourEndpoint = `opc.tcp://127.0.0.1:${port}/UA/AAS`;
}

beforeAll(async () => {
  try {
    await startOurs(14890);
  } catch {
    await startOurs(14891);
  }
  try {
    device = await startTestServer(14892);
  } catch {
    device = await startTestServer(14893);
  }
}, 60_000);

afterAll(async () => {
  await ours?.stop();
  await device?.stop();
});

describe('자기 자신 훑기', () => {
  it('🔴 우리 서버를 훑으려 하면 막는다 — 명판 정보가 「수집할 태그」로 돌아오는 사고', async () => {
    const selfUri = ours.currentStatus().instanceUri!;
    expect(selfUri).toBeTruthy();

    await expect(browseDevice({ endpoint: ourEndpoint, selfUri })).rejects.toThrow(SelfBrowseError);
    await expect(browseDevice({ endpoint: ourEndpoint, selfUri })).rejects.toThrow(
      /이 저작도구가 값을 내주는/,
    );
  }, 30_000);

  it('막힌 이유를 구별해 말한다 — 바로 나 자신인가, 다른 대의 같은 도구인가', async () => {
    const selfUri = ours.currentStatus().instanceUri!;
    const mine = await browseDevice({ endpoint: ourEndpoint, selfUri }).catch((e: unknown) => e);
    expect((mine as SelfBrowseError).kind).toBe('self');

    // selfUri를 안 주면(=다른 프로세스에서 본 것) productUri로 같은 도구임을 알아낸다
    const other = await browseDevice({ endpoint: ourEndpoint }).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(SelfBrowseError);
    expect((other as SelfBrowseError).kind).toBe('sibling');
    expect((other as SelfBrowseError).message).toContain('다른 컴퓨터');
  }, 30_000);

  it('🔴 진짜 설비는 그대로 훑는다 — 차단이 정상 동작을 막으면 안 된다', async () => {
    const selfUri = ours.currentStatus().instanceUri!;
    const result = await browseDevice({ endpoint: device.endpoint, selfUri });
    expect(result.nodes.map((node) => node.name)).toContain('MotorSpeed');
  }, 30_000);
});
