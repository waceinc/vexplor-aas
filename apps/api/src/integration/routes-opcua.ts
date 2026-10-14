/**
 * OPC UA client certificate trust routes (docs/design/integration-v1.md §4.6, §7) — admin session only.
 *
 *   GET  /integrations/opcua/certificates                       trusted and rejected client certificates
 *   POST /integrations/opcua/certificates/:thumbprint/trust     move a rejected certificate to trusted
 *
 * In secure mode an MES connecting for the first time is refused and its certificate lands in "rejected"; an
 * administrator compares the thumbprint with the one the MES shows and trusts it here (the UaExpert walkthrough).
 * When the OPC UA server is off or runs insecure there is no trust store: 409.
 */
import { fill, tr } from '@aas/core';
import { ApiError, json } from '../http.js';
import type { Route } from '../router.js';
import type { IntegrationRouteDeps } from './deps.js';
import { recordAudit, requireAdminSession, type IntegrationRouteStore } from './route-support.js';

function trustStore(deps: IntegrationRouteDeps) {
  const pki = deps.runtime?.opcuaPki?.();
  if (!pki) {
    throw new ApiError(409, 'OpcUaNotSecure', tr('OPC UA 서버가 꺼져 있거나 보안 없이 실행 중이라 인증서 저장소가 없습니다.'));
  }
  return pki;
}

/** What the API shows of a certificate — never the server-side file path */
function view(certificate: { thumbprint: string; subject?: string; notAfter?: string }) {
  return { thumbprint: certificate.thumbprint, subject: certificate.subject ?? null, notAfter: certificate.notAfter ?? null };
}

export function opcuaRoutes(store: IntegrationRouteStore, deps: IntegrationRouteDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/integrations/opcua/certificates',
      async handle({ request }) {
        requireAdminSession(request);
        const { trusted, rejected } = await trustStore(deps).list();
        return json(200, { trusted: trusted.map(view), rejected: rejected.map(view) });
      },
    },
    {
      method: 'POST',
      pattern: '/integrations/opcua/certificates/:thumbprint/trust',
      async handle({ request, params }) {
        requireAdminSession(request);
        const thumbprint = params['thumbprint']!.toLowerCase().replace(/[^0-9a-f]/g, '');
        if (!/^[0-9a-f]{40}$/.test(thumbprint)) throw new ApiError(400, 'BadRequest', tr('지문은 SHA-1 16진수 40자여야 합니다.'));
        const pki = trustStore(deps);
        if (!(await pki.trust(thumbprint))) {
          throw new ApiError(404, 'NotFound', fill(tr('거부된 인증서 중에 지문 {0}인 것이 없습니다.'), { 0: thumbprint }));
        }
        await recordAudit(deps.auditStore ?? store, request, 'config.updated', `opcua/certificates/${thumbprint}`, { operation: 'trust' });
        return json(200, { trusted: thumbprint });
      },
    },
  ];
}
