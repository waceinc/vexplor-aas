/**
 * The client side of a secure OPC UA connection — shared by the collector's reader and "Load from equipment" (browse),
 * so both connect to a factory server the same way (2.8.0: browse used to be None and anonymous only).
 *
 * Important: policies are checked before any connection — a typo or an outdated policy must not fall back to something
 *    weaker. The certificate store is always a folder we name (node-opcua's default lives in the user's home folder).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fill, tr } from '@aas/core';
import { MessageSecurityMode, OPCUACertificateManager, OPCUAClient, SecurityPolicy, UserTokenType, type UserIdentityInfo } from 'node-opcua';

/** OPC UA channel security as AID 1.1 states it (`uav_securityMode`, `uav_securityPolicy` — IDTA-02017 1.1 §2.27.7) */
export interface OpcUaSecurity {
  mode: 'None' | 'Sign' | 'SignAndEncrypt';
  /** Default Basic256Sha256 when the mode is not None */
  policy?: string;
}

/** Policies we connect with. The two the OPC UA WoT binding calls outdated (Basic256, Basic128Rsa15) are refused */
const POLICIES: Record<string, SecurityPolicy> = {
  None: SecurityPolicy.None,
  Basic256Sha256: SecurityPolicy.Basic256Sha256,
  Aes128_Sha256_RsaOaep: SecurityPolicy.Aes128_Sha256_RsaOaep,
  Aes256_Sha256_RsaPss: SecurityPolicy.Aes256_Sha256_RsaPss,
};

export interface SecureClientOptions {
  security?: OpcUaSecurity;
  user?: { userName: string; password: string };
  pkiDir?: string;
  trustUnknownServer?: boolean;
  connectTimeoutMs?: number;
}

/** A client set up for the chosen security, its certificate store, and the identity to open a session with */
export async function secureClient(
  options: SecureClientOptions,
): Promise<{ client: OPCUAClient; certificates: OPCUACertificateManager; identity: UserIdentityInfo }> {
  const timeout = options.connectTimeoutMs ?? 5000;
  const mode = options.security?.mode ?? 'None';
  const policyName = mode === 'None' ? 'None' : (options.security?.policy ?? 'Basic256Sha256');
  const policy = POLICIES[policyName];
  if (!policy) throw new Error(fill(tr('지원하지 않는 OPC UA 보안 정책입니다: {0}'), { 0: policyName }));
  if (mode !== 'None' && policy === SecurityPolicy.None) throw new Error(tr('Sign · SignAndEncrypt 에는 None 이 아닌 보안 정책이 필요합니다.'));
  if (mode !== 'None' && !options.pkiDir) throw new Error(tr('보안 연결에는 인증서 폴더(pkiDir)가 필요합니다.'));

  // Without a folder (None only) a fixed folder under the temp directory — never node-opcua's default in the home folder
  const certificates = new OPCUACertificateManager({
    rootFolder: options.pkiDir ?? join(tmpdir(), 'vexplor-opcua-reader-pki'),
    automaticallyAcceptUnknownCertificate: options.trustUnknownServer === true,
  });
  await certificates.initialize();
  const client = OPCUAClient.create({
    // Field equipment often does not report an accurate endpoint list.
    // We may also be unable to resolve the hostname the server advertises (.local, etc.), so the address is used as-is
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 0, initialDelay: 200, maxDelay: 1000 },
    requestedSessionTimeout: Math.max(timeout, 10_000),
    securityMode: MessageSecurityMode[mode],
    securityPolicy: policy,
    clientCertificateManager: certificates,
  });
  const identity: UserIdentityInfo = options.user
    ? { type: UserTokenType.UserName, userName: options.user.userName, password: options.user.password }
    : { type: UserTokenType.Anonymous };
  return { client, certificates, identity };
}
