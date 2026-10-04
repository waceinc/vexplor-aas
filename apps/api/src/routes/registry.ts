/**
 * AAS Registry & Discovery (IDTA Part 2).
 *
 * BaSyx는 이것을 **별도 서비스**로 둔다 — 앱이 자기 AAS를 등록해 두면, 다른 시스템이
 * 자산 ID로 "그 AAS가 어디 있는지" 찾는다. 설비가 여러 서버에 흩어지면 이게 없으면 못 찾는다.
 *
 * 🔴 **우리는 등록을 받지 않고 파생시킨다.** 이 서버가 저장소이기도 하므로, 무엇을 갖고 있는지
 *    이미 안다. 등록 절차를 두면 **등록과 실제가 어긋나는 순간**이 생긴다(BaSyx에서 흔한 사고다) —
 *    파일을 지웠는데 레지스트리에는 남아 있는 식이다. 파생시키면 어긋날 자리가 없다.
 *
 * 🔴 지금은 **읽기(GET)만** 연다. 다른 서버에 있는 AAS를 등록해 두는 쓰기(POST·PUT·DELETE)는
 *    보관 자리(저장소 스키마)가 필요해 다음 단계로 미뤘다. 규격 대조표에 미구현으로 남는다 —
 *    "있는 척"보다 낫다.
 */
import type { AssetAdministrationShell, Environment, Submodel } from '@aas/core';
import type { AasStore } from '@aas/store';
import { encodeIdentifier } from '../base64url.js';
import { ApiError, json, pagedResponse, type ApiRequest } from '../http.js';
import type { Route } from '../router.js';
import { decodeIdentifier } from '../base64url.js';

/** 규격이 정한 인터페이스 이름 */
const AAS_INTERFACE = 'AAS-3.0';
const SUBMODEL_INTERFACE = 'SUBMODEL-3.0';

export interface RegistryOptions {
  /**
   * 밖에서 이 서버를 부르는 주소. 없으면 요청의 Host 헤더에서 만든다.
   * 🔴 레지스트리가 알려 주는 주소가 틀리면 아무도 못 찾아온다 — 리버스 프록시 뒤에 두면 반드시 준다.
   */
  publicBaseUrl?: string;
}

function baseUrlOf(request: ApiRequest, options: RegistryOptions): string {
  if (options.publicBaseUrl) return options.publicBaseUrl.replace(/\/+$/, '');
  const host = request.headers['host'];
  if (!host) return '';
  const scheme = request.headers['x-forwarded-proto'] ?? 'http';
  return `${scheme}://${host}`;
}

interface Endpoint {
  interface: string;
  protocolInformation: {
    href: string;
    endpointProtocol: string;
    endpointProtocolVersion: string[];
  };
}

function endpoint(href: string, interfaceName: string): Endpoint {
  return {
    interface: interfaceName,
    protocolInformation: {
      href,
      endpointProtocol: 'HTTP',
      endpointProtocolVersion: ['1.1'],
    },
  };
}

export interface SubmodelDescriptor {
  id: string;
  idShort?: string;
  semanticId?: unknown;
  administration?: unknown;
  description?: unknown;
  displayName?: unknown;
  endpoints: Endpoint[];
}

export interface ShellDescriptor {
  id: string;
  idShort?: string;
  assetKind?: string;
  assetType?: string;
  globalAssetId?: string;
  specificAssetIds?: unknown[];
  administration?: unknown;
  description?: unknown;
  displayName?: unknown;
  endpoints: Endpoint[];
  submodelDescriptors: SubmodelDescriptor[];
}

function submodelDescriptor(submodel: Submodel, base: string, packageId: string): SubmodelDescriptor {
  const raw = submodel as unknown as Record<string, unknown>;
  const href = `${base}/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodel.id)}`;
  return {
    id: submodel.id,
    ...(submodel.idShort === undefined ? {} : { idShort: submodel.idShort }),
    ...(raw['semanticId'] === undefined ? {} : { semanticId: raw['semanticId'] }),
    ...(raw['administration'] === undefined ? {} : { administration: raw['administration'] }),
    ...(raw['description'] === undefined ? {} : { description: raw['description'] }),
    ...(raw['displayName'] === undefined ? {} : { displayName: raw['displayName'] }),
    endpoints: [endpoint(href, SUBMODEL_INTERFACE)],
  };
}

/** AAS가 참조하는 서브모델만 딸려 붙인다 — 파일 안에 있어도 매달리지 않은 것은 그 AAS 것이 아니다 */
function referencedSubmodels(shell: AssetAdministrationShell, environment: Environment): Submodel[] {
  const wanted = new Set(
    ((shell as unknown as Record<string, unknown>)['submodels'] as
      | { keys?: { value: string }[] }[]
      | undefined
      ?? []
    ).map((reference) => reference.keys?.[0]?.value ?? ''),
  );
  return (environment.submodels ?? []).filter((submodel) => wanted.has(submodel.id));
}

function shellDescriptor(
  shell: AssetAdministrationShell,
  environment: Environment,
  base: string,
  packageId: string,
): ShellDescriptor {
  const raw = shell as unknown as Record<string, unknown>;
  const asset = (raw['assetInformation'] ?? {}) as Record<string, unknown>;
  const href = `${base}/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(shell.id)}`;

  return {
    id: shell.id,
    ...(shell.idShort === undefined ? {} : { idShort: shell.idShort }),
    ...(asset['assetKind'] === undefined ? {} : { assetKind: String(asset['assetKind']) }),
    ...(asset['assetType'] === undefined ? {} : { assetType: String(asset['assetType']) }),
    ...(asset['globalAssetId'] === undefined
      ? {}
      : { globalAssetId: String(asset['globalAssetId']) }),
    ...(asset['specificAssetIds'] === undefined
      ? {}
      : { specificAssetIds: asset['specificAssetIds'] as unknown[] }),
    ...(raw['administration'] === undefined ? {} : { administration: raw['administration'] }),
    ...(raw['description'] === undefined ? {} : { description: raw['description'] }),
    ...(raw['displayName'] === undefined ? {} : { displayName: raw['displayName'] }),
    endpoints: [endpoint(href, AAS_INTERFACE)],
    submodelDescriptors: referencedSubmodels(shell, environment).map((submodel) =>
      submodelDescriptor(submodel, base, packageId),
    ),
  };
}

interface Held {
  descriptor: ShellDescriptor;
  packageId: string;
  updatedAt: string;
}

/**
 * 이 서버가 가진 것을 전부 훑어 서술자를 만든다.
 * 🔴 파일 수에 비례해 훑는다. 설비 수백 대가 되면 색인을 따로 둬야 한다 — 지금은 정직하게 훑는다.
 */
async function scan(store: AasStore, base: string): Promise<Held[]> {
  const out: Held[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listPackages(cursor === undefined ? {} : { cursor });
    for (const record of page.items) {
      const environment = await store.getEnvironment(record.id);
      for (const shell of environment.assetAdministrationShells ?? []) {
        out.push({
          descriptor: shellDescriptor(shell, environment, base, record.id),
          packageId: record.id,
          updatedAt: String((record as unknown as Record<string, unknown>)['updatedAt'] ?? ''),
        });
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
}

/**
 * 🔴 같은 AAS id가 두 파일에 있으면 **하나만 알려 준다.** 레지스트리에서 같은 id가 둘이면
 *    찾는 쪽이 어느 것을 써야 할지 알 수 없다 — 같은 파일을 두 번 올리면 실제로 생기는 일이다.
 *    최근에 바뀐 파일을 남긴다. 겹친 사실은 `/registry-conflicts`에서 볼 수 있다.
 */
function dedupe(held: readonly Held[]): ShellDescriptor[] {
  const best = new Map<string, Held>();
  for (const entry of held) {
    const previous = best.get(entry.descriptor.id);
    if (!previous || entry.updatedAt > previous.updatedAt) best.set(entry.descriptor.id, entry);
  }
  return [...best.values()].map((entry) => entry.descriptor);
}

async function allDescriptors(store: AasStore, base: string): Promise<ShellDescriptor[]> {
  return dedupe(await scan(store, base));
}

/** 질의 인자의 자산 식별자 — base64url로 감싼 JSON이다(규격) */
function parseAssetIds(request: ApiRequest): { name: string; value: string }[] {
  const values = request.queryAll?.['assetIds'] ?? (request.query['assetIds'] ? [request.query['assetIds']] : []);
  const out: { name: string; value: string }[] = [];
  for (const raw of values) {
    let text = raw;
    try {
      // 규격은 base64url을 요구하지만, 날것 JSON으로 보내는 구현도 흔하다 — 둘 다 받는다
      text = raw.trim().startsWith('{') ? raw : decodeIdentifier(raw);
    } catch {
      throw new ApiError(400, 'BadRequest', `assetIds를 해석하지 못했습니다: ${raw}`);
    }
    try {
      const parsed = JSON.parse(text) as { name?: string; value?: string };
      if (typeof parsed.value !== 'string') throw new Error('value 없음');
      out.push({ name: parsed.name ?? 'globalAssetId', value: parsed.value });
    } catch {
      throw new ApiError(400, 'BadRequest', `assetIds가 SpecificAssetId 모양이 아닙니다: ${text}`);
    }
  }
  return out;
}

/** 그 AAS가 가진 자산 식별자 전부 — globalAssetId도 한 항목으로 본다(디스커버리 규약) */
function assetLinksOf(descriptor: ShellDescriptor): { name: string; value: string }[] {
  const links: { name: string; value: string }[] = [];
  if (descriptor.globalAssetId !== undefined) {
    links.push({ name: 'globalAssetId', value: descriptor.globalAssetId });
  }
  for (const item of descriptor.specificAssetIds ?? []) {
    const entry = item as { name?: string; value?: string };
    if (typeof entry.value === 'string') {
      links.push({ name: entry.name ?? 'specificAssetId', value: entry.value });
    }
  }
  return links;
}

export function registryRoutes(store: AasStore, options: RegistryOptions = {}): Route[] {
  const BASE = '/api/v3.0';

  const find = async (request: ApiRequest, id: string): Promise<ShellDescriptor> => {
    const all = await allDescriptors(store, baseUrlOf(request, options));
    const found = all.find((descriptor) => descriptor.id === id);
    if (!found) throw new ApiError(404, 'NotFound', `등록된 AAS가 없습니다: ${id}`);
    return found;
  };

  return [
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors`,
      async handle({ request }) {
        let all = await allDescriptors(store, baseUrlOf(request, options));
        const assetKind = request.query['assetKind'];
        const assetType = request.query['assetType'];
        if (assetKind) all = all.filter((descriptor) => descriptor.assetKind === assetKind);
        if (assetType) all = all.filter((descriptor) => descriptor.assetType === assetType);
        return pagedResponse(all);
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors/:aasIdentifier`,
      async handle({ params, request }) {
        return json(200, await find(request, decodeIdentifier(params['aasIdentifier']!)));
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors/:aasIdentifier/submodel-descriptors`,
      async handle({ params, request }) {
        const descriptor = await find(request, decodeIdentifier(params['aasIdentifier']!));
        return pagedResponse(descriptor.submodelDescriptors);
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors/:aasIdentifier/submodel-descriptors/:submodelIdentifier`,
      async handle({ params, request }) {
        const descriptor = await find(request, decodeIdentifier(params['aasIdentifier']!));
        const wanted = decodeIdentifier(params['submodelIdentifier']!);
        const found = descriptor.submodelDescriptors.find((entry) => entry.id === wanted);
        if (!found) throw new ApiError(404, 'NotFound', `그 AAS에 매달린 서브모델이 아닙니다: ${wanted}`);
        return json(200, found);
      },
    },
    {
      /** 서브모델 레지스트리 — AAS를 거치지 않고 서브모델만 찾는 자리 */
      method: 'GET',
      pattern: `${BASE}/submodel-descriptors`,
      async handle({ request }) {
        const all = await allDescriptors(store, baseUrlOf(request, options));
        const seen = new Map<string, SubmodelDescriptor>();
        for (const descriptor of all) {
          for (const submodel of descriptor.submodelDescriptors) seen.set(submodel.id, submodel);
        }
        return pagedResponse([...seen.values()]);
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/submodel-descriptors/:submodelIdentifier`,
      async handle({ params, request }) {
        const wanted = decodeIdentifier(params['submodelIdentifier']!);
        const all = await allDescriptors(store, baseUrlOf(request, options));
        for (const descriptor of all) {
          const found = descriptor.submodelDescriptors.find((entry) => entry.id === wanted);
          if (found) return json(200, found);
        }
        throw new ApiError(404, 'NotFound', `등록된 서브모델이 없습니다: ${wanted}`);
      },
    },
    {
      /**
       * 디스커버리 — **자산 ID로 AAS를 찾는다.** 이 레지스트리의 존재 이유다.
       * 현장 시스템은 AAS id가 아니라 자산 번호(일련번호·설비코드)를 들고 온다.
       */
      method: 'GET',
      pattern: `${BASE}/lookup/shells`,
      async handle({ request }) {
        const wanted = parseAssetIds(request);
        const all = await allDescriptors(store, baseUrlOf(request, options));
        if (wanted.length === 0) return pagedResponse(all.map((descriptor) => descriptor.id));

        const matches = all.filter((descriptor) => {
          const links = assetLinksOf(descriptor);
          // 여러 개를 주면 **전부** 맞아야 한다(규격: AND)
          return wanted.every((want) =>
            links.some((link) => link.value === want.value && (want.name === 'globalAssetId' || link.name === want.name)),
          );
        });
        return pagedResponse(matches.map((descriptor) => descriptor.id));
      },
    },
    {
      /**
       * 🔴 규격 밖 — **겹친 id 점검**. 표준 응답에는 하나만 나가므로, 겹쳤다는 사실을
       *    알릴 자리가 따로 필요하다. 같은 파일을 두 번 올리면 바로 생긴다.
       */
      method: 'GET',
      pattern: '/registry-conflicts',
      async handle({ request }) {
        const held = await scan(store, baseUrlOf(request, options));
        const byId = new Map<string, Held[]>();
        for (const entry of held) {
          byId.set(entry.descriptor.id, [...(byId.get(entry.descriptor.id) ?? []), entry]);
        }
        const conflicts = [...byId.entries()]
          .filter(([, entries]) => entries.length > 1)
          .map(([id, entries]) => ({
            id,
            idShort: entries[0]!.descriptor.idShort,
            packages: entries.map((entry) => entry.packageId),
            /** 표준 응답에 나가는 쪽 */
            serving: entries.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).packageId,
          }));
        return json(200, { total: held.length, conflicts });
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/lookup/shells/:aasIdentifier`,
      async handle({ params, request }) {
        const descriptor = await find(request, decodeIdentifier(params['aasIdentifier']!));
        return json(200, assetLinksOf(descriptor));
      },
    },
  ];
}
