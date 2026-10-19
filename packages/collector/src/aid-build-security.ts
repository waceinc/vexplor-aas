/**
 * The security part of a built AID (2.8.0) — what the "Create collection link" screen lets a person choose:
 * OPC UA channel security (mode · policy), and for OPC UA and MQTT whether the device wants a user name and password.
 *
 * Written as the AID states it (IDTA-02017 1.1 §2.25, §2.27.7 – 2.27.9 · W3C WoT security vocabulary): EndpointMetadata
 * gets a `security` list of references into `securityDefinitions`, which holds the schemes. `parseAid` reads it back
 * (aid.ts `securityOf`) — tests pin the round trip.
 *
 * Important: **never a secret.** The AID says only *that* a login is needed. The user name and password stay with the
 *    installer — the server's credentials file and the edge machine's credentials.json, both keyed by the address.
 * Important: nothing is written when nothing is chosen — an AID built without security is the same as before 2.8.0.
 */
import { fill, tr } from '@aas/core';
import { AidBuildError, prop, referenceList, smc } from './aid-build-parts.js';

const UAV = 'http://opcfoundation.org/UA/WoT-Binding/';
const WOTSEC = 'https://www.w3.org/2019/wot/security#';
const TERM = {
  security: 'https://www.w3.org/2019/wot/td#hasSecurityConfiguration',
  securityDefinitions: 'https://www.w3.org/2019/wot/td#definesSecurityScheme',
  scheme: `${WOTSEC}SecurityScheme`,
  allOf: `${WOTSEC}allOf`,
  combo: `${WOTSEC}ComboSecurityScheme`,
  basic: `${WOTSEC}BasicSecurityScheme`,
  channel: `${UAV}OPCUASecurityChannelScheme`,
  authentication: `${UAV}OPCUASecurityAuthenticationScheme`,
  securityMode: `${UAV}securityMode`,
  securityPolicy: `${UAV}securityPolicy`,
  userIdentityToken: `${UAV}userIdentityToken`,
} as const;

/** Policies the collector connects with (@aas/opcua reader) — the outdated Basic256 and Basic128Rsa15 are not offered */
export const OPCUA_POLICIES = ['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'] as const;
const MODES = ['None', 'Sign', 'SignAndEncrypt'] as const;

export interface AidSecurityInput {
  /** OPC UA channel security. Absent or None: no signing */
  mode?: 'None' | 'Sign' | 'SignAndEncrypt';
  /** OPC UA security policy, needed when mode is Sign or SignAndEncrypt */
  policy?: string;
  /** The device wants a user name and password — OPC UA UserName token, MQTT login. The pair itself stays outside the AAS */
  login?: boolean;
}

/** Refuses what the collector could not connect with — a wrong choice found here, not on the factory floor */
export function checkSecurity(protocol: 'OPCUA' | 'MODBUS' | 'MQTT' | 'S7' | 'MC', security: AidSecurityInput | undefined): void {
  if (!security) return;
  const mode = security.mode ?? 'None';
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new AidBuildError(fill(tr('보안 방식이 이상합니다: {0} — 쓸 수 있는 것: {1}'), { 0: String(mode), 1: MODES.join(' · ') }));
  }
  if (protocol !== 'OPCUA' && (mode !== 'None' || security.policy !== undefined)) {
    throw new AidBuildError(tr('보안 방식과 보안 정책은 OPC UA 에만 있습니다.'));
  }
  if (protocol === 'MODBUS' && security.login) throw new AidBuildError(tr('Modbus TCP 에는 로그인이 없습니다.'));
  // S7 PUT/GET and the MC protocol read without a login (an S7 protection-level password is not supported)
  if ((protocol === 'S7' || protocol === 'MC') && security.login) throw new AidBuildError(tr('S7 · MC 프로토콜 읽기에는 로그인이 없습니다.'));
  if (mode !== 'None' && !(OPCUA_POLICIES as readonly string[]).includes(security.policy ?? '')) {
    throw new AidBuildError(
      fill(tr('보안 정책이 이상합니다: {0} — 쓸 수 있는 것: {1}'), { 0: security.policy ?? '', 1: OPCUA_POLICIES.join(' · ') }),
    );
  }
}

/** The schemes for the choice; `named` is the one `security` points at. `below` = the path from the interface down */
function schemes(iriBase: string, submodelId: string, below: readonly string[], protocol: string, security: AidSecurityInput): { named: string; elements: unknown[] } | undefined {
  const mode = security.mode ?? 'None';
  const parts: unknown[] = [];
  const names: string[] = [];
  if (protocol === 'OPCUA' && mode !== 'None') {
    names.push('opcua_channel_sc');
    parts.push(
      smc(iriBase, 'opcua_channel_sc', TERM.channel, [
        prop(iriBase, 'scheme', TERM.scheme, 'uav:channel-security'),
        prop(iriBase, 'uav_securityMode', TERM.securityMode, mode),
        prop(iriBase, 'uav_securityPolicy', TERM.securityPolicy, security.policy!),
      ]),
    );
  }
  if (protocol === 'OPCUA' && security.login) {
    names.push('opcua_authentication_sc');
    parts.push(
      smc(iriBase, 'opcua_authentication_sc', TERM.authentication, [
        prop(iriBase, 'scheme', TERM.scheme, 'uav:authentication'),
        prop(iriBase, 'uav_userIdentityToken', TERM.userIdentityToken, 'UserName'),
      ]),
    );
  }
  if (protocol === 'MQTT' && security.login) {
    names.push('basic_sc');
    parts.push(smc(iriBase, 'basic_sc', TERM.basic, [prop(iriBase, 'scheme', TERM.scheme, 'basic')]));
  }
  if (names.length === 0) return undefined;
  if (names.length === 1) return { named: names[0]!, elements: parts };
  // Channel security and login together — a combo scheme joins them (WoT `allOf`)
  const combo = smc(iriBase, 'combo_sc', TERM.combo, [
    prop(iriBase, 'scheme', TERM.scheme, 'combo'),
    referenceList(iriBase, 'allOf', TERM.allOf, names.map((name) => [...below, name]), submodelId),
  ]);
  return { named: 'combo_sc', elements: [...parts, combo] };
}

/** The EndpointMetadata elements for the chosen security — `security` and `securityDefinitions` — or nothing */
export function securityElements(iriBase: string, submodelId: string, interfaceName: string, protocol: string, security: AidSecurityInput | undefined): unknown[] {
  if (!security) return [];
  const below = [interfaceName, 'EndpointMetadata', 'securityDefinitions'];
  const built = schemes(iriBase, submodelId, below, protocol, security);
  if (!built) return [];
  return [
    referenceList(iriBase, 'security', TERM.security, [[...below, built.named]], submodelId),
    smc(iriBase, 'securityDefinitions', TERM.securityDefinitions, built.elements),
  ];
}

/** [idShort, term] of every own term the chosen security uses — their ConceptDescriptions keep KOSMO-SME-3 quiet */
export function securityTerms(protocol: string, security: AidSecurityInput | undefined): [string, string][] {
  if (!security) return [];
  const mode = security.mode ?? 'None';
  const out: [string, string][] = [];
  if (protocol === 'OPCUA' && mode !== 'None') {
    out.push(['opcua_channel_sc', TERM.channel], ['uav_securityMode', TERM.securityMode], ['uav_securityPolicy', TERM.securityPolicy]);
  }
  if (protocol === 'OPCUA' && security.login) out.push(['opcua_authentication_sc', TERM.authentication], ['uav_userIdentityToken', TERM.userIdentityToken]);
  if (protocol === 'MQTT' && security.login) out.push(['basic_sc', TERM.basic]);
  if (out.length === 0) return [];
  const combo = out.filter(([name]) => name.endsWith('_sc')).length > 1;
  return [
    ['security', TERM.security],
    ['securityDefinitions', TERM.securityDefinitions],
    ['scheme', TERM.scheme],
    ...(combo ? ([['combo_sc', TERM.combo], ['allOf', TERM.allOf]] as [string, string][]) : []),
    ...out,
  ];
}
