/**
 * Collection link checks — the AssetInterfacesDescription (AID, IDTA-02017) a file carries for collection (2.8.0).
 *
 * Important: not a KOSMO rule. It guards something the submission validator does not look at: an AID address that
 *    carries a user name and password (`mqtt://user:password@host`). Before 2.8.0 that was the only way to log in to an
 *    MQTT broker, so older files may have one. The file then carries the password to everyone it is shared with, and the
 *    edge read list would hand it to every factory PC — the server leaves such an interface out of the list.
 */
import type { SubmodelElement } from '@aas/core';
import { fill, tr } from '@aas/core';
import type { LintContext, Report, Rule } from '../types.js';

const AID_PREFIX = 'https://admin-shell.io/idta/AssetInterfacesDescription/';
const USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

function children(node: unknown): SubmodelElement[] {
  const value = (node as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? (value as SubmodelElement[]) : [];
}

export const aid1AddressSecret: Rule = {
  id: 'AID-1',
  layer: 'L3',
  get title() {
    return tr('수집 연결 주소 검사 — 접속 주소(base)에 사용자 이름 · 암호를 넣지 않는다');
  },
  source: 'IDTA-02017 AssetInterfacesDescription · W3C WoT Security',
  check(ctx: LintContext, report: Report) {
    (ctx.environment.submodels ?? []).forEach((submodel, s) => {
      const semantic = submodel.semanticId?.keys?.[0]?.value ?? '';
      if (!semantic.startsWith(AID_PREFIX) && submodel.idShort !== 'AssetInterfacesDescription') return;
      ((submodel.submodelElements ?? []) as SubmodelElement[]).forEach((iface, i) => {
        const endpoint = children(iface).findIndex((element) => element.idShort === 'EndpointMetadata');
        if (endpoint < 0) return;
        const elements = children(children(iface)[endpoint]);
        const b = elements.findIndex((element) => element.idShort === 'base');
        const value = (elements[b] as { value?: unknown } | undefined)?.value;
        if (typeof value !== 'string' || !USER_INFO.test(value.trim())) return;
        const pointer = `/submodels/${s}/submodelElements/${i}/value/${endpoint}/value/${b}`;
        report({
          severity: 'warning',
          elementType: 'Property',
          key: 'base',
          pointer,
          kosmoPath: `/submodels/${s}(${submodel.idShort ?? submodel.id})/${iface.idShort ?? i}/EndpointMetadata/base`,
          // Important: the message names the address without the secret — reports are shared and printed
          message: fill(tr('접속 주소에 사용자 이름 · 암호가 들어 있습니다: {0} — 파일을 받는 모든 사람에게 비밀번호가 함께 갑니다. 원격 수집기 목록에서도 빠집니다.'), {
            0: value.trim().replace(USER_INFO, '$1***@'),
          }),
          remedy: tr('「연결수정」에서 주소의 사용자 이름 · 암호를 떼고 「로그인 필요」를 켜십시오. 사용자 이름 · 암호는 서버의 credentials 파일과 공장 PC 의 credentials.json 에 그 주소로 적습니다.'),
          fixable: false,
        });
      });
    });
  },
};

export const COLLECT_RULES: readonly Rule[] = [aid1AddressSecret];
