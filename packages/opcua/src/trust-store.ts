/**
 * The OPC UA server's client certificate trust store as the API sees it (docs/design/integration-v1.md §7): list trusted
 * and rejected certificates with their SHA-1 thumbprints, and move a rejected one to trusted.
 *
 * Why thumbprints: an administrator compares the thumbprint the MES (or UaExpert) shows for its own certificate with
 * the one listed here before trusting it — trusting by file name or subject alone would let anyone who connects once
 * with a look-alike subject be trusted.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OPCUACertificateManager } from 'node-opcua';

/** One client certificate in the server's trust store */
export interface OpcUaCertificateInfo {
  /** SHA-1 of the DER bytes, lowercase hex — the thumbprint OPC UA tools (UaExpert) show */
  thumbprint: string;
  subject?: string;
  /** ISO time */
  notAfter?: string;
  file: string;
}

/** Trusted and rejected client certificates — only in secure mode */
export interface OpcUaTrustStore {
  list(): Promise<{ trusted: OpcUaCertificateInfo[]; rejected: OpcUaCertificateInfo[] }>;
  /** Moves a rejected certificate to trusted. False when no rejected certificate has that thumbprint */
  trust(thumbprint: string): Promise<boolean>;
}

/** The trust store backed by a node-opcua certificate manager (its trusted / rejected folders) */
export function trustStoreOf(manager: OPCUACertificateManager): OpcUaTrustStore {
  return {
    list: async () => ({ trusted: await certificatesIn(manager.trustedFolder), rejected: await certificatesIn(manager.rejectedFolder) }),
    trust: async (thumbprint) => {
      const wanted = normalizeThumbprint(thumbprint);
      const found = (await certificatesWithBytes(manager.rejectedFolder)).find((entry) => entry.info.thumbprint === wanted);
      if (!found) return false;
      await manager.trustCertificate(found.der);
      return true;
    },
  };
}

function normalizeThumbprint(text: string): string {
  return text.toLowerCase().replace(/[^0-9a-f]/g, '');
}

/** DER bytes of a certificate file — node-opcua stores DER (`.der`), people may drop PEM (`.pem`) */
function derOf(bytes: Buffer): Buffer {
  const text = bytes.toString('latin1');
  const pem = /-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/.exec(text);
  return pem ? Buffer.from(pem[1]!.replace(/\s+/g, ''), 'base64') : bytes;
}

async function certificatesWithBytes(folder: string): Promise<{ info: OpcUaCertificateInfo; der: Buffer }[]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  const out: { info: OpcUaCertificateInfo; der: Buffer }[] = [];
  for (const name of names.sort()) {
    if (!/\.(der|pem|crt|cer)$/i.test(name)) continue;
    const file = join(folder, name);
    try {
      const der = derOf(await readFile(file));
      const info: OpcUaCertificateInfo = { thumbprint: createHash('sha1').update(der).digest('hex'), file: name };
      try {
        const x509 = new X509Certificate(der);
        info.subject = x509.subject.replace(/\n/g, ', ');
        info.notAfter = new Date(x509.validTo).toISOString();
      } catch {
        // Unparseable file: still listed by thumbprint so a person can see and remove it
      }
      out.push({ info, der });
    } catch {
      // A file vanishing between readdir and readFile (a concurrent trust) is not an error worth reporting
    }
  }
  return out;
}

async function certificatesIn(folder: string): Promise<OpcUaCertificateInfo[]> {
  return (await certificatesWithBytes(folder)).map((entry) => entry.info);
}
