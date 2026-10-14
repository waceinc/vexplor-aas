/**
 * Document index export `vexplor.documents/1` (design §4.4, ERP §2.3, CMMS §5, T15).
 *
 * One row per `Documents[] × DocumentVersions[] × DigitalFiles[]`, keyed by the business key `DocumentIdentifier`
 * (never the list index — reordering documents in the editor must not re-map rows, ERP E-9). A CMMS cannot open
 * `file:///manual.pdf`, so each file gets the Part 2 attachment URL plus size and sha256 of the stored part; a part the
 * package does not hold is `available: false, url: null`, never a broken link.
 */
import { createHash } from 'node:crypto';
import type { Environment } from '@aas/core';
import type { PackageFileRecord } from '@aas/store';
import { encodeIdentifier } from '../../base64url.js';
import {
  booleanOf,
  child,
  findSubmodel,
  idShortOf,
  locatedChildren,
  modelTypeOf,
  packagePartOf,
  shellsOf,
  submodelsOf,
  textOf,
  topElements,
  type Json,
  type Located,
} from './elements.js';

export interface FileLink {
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  sha256: string | null;
  available: boolean;
  url: string | null;
}

/** Resolves a File element to its download link */
export type FileResolver = (submodelId: string, idShortPath: string, element: Json) => FileLink;

/**
 * Part 2 attachment URL of a File element. Absolute when the public base URL is known (`AAS_PUBLIC_URL`), else
 * path-only. The idShortPath may contain list indexes — fine for a link, never used as a join key.
 */
export function attachmentUrl(packageId: string, submodelId: string, idShortPath: string, publicBaseUrl?: string): string {
  const base = (publicBaseUrl ?? '').replace(/\/+$/, '');
  return `${base}/packages/${encodeURIComponent(packageId)}/api/v3.0/submodels/${encodeIdentifier(submodelId)}/submodel-elements/${encodeURIComponent(idShortPath)}/attachment`;
}

export function createFileResolver(packageId: string, files: readonly PackageFileRecord[], publicBaseUrl?: string): FileResolver {
  const byPart = new Map(files.map((file) => [file.part, file]));
  return (submodelId, idShortPath, element) => {
    const value = typeof element['value'] === 'string' && element['value'] !== '' ? element['value'] : null;
    const declared = typeof element['contentType'] === 'string' && element['contentType'] !== '' ? element['contentType'] : null;
    const part = packagePartOf(value);
    const file = part === undefined ? undefined : byPart.get(part);
    if (!file) return { fileName: value, contentType: declared, size: null, sha256: null, available: false, url: null };
    return {
      fileName: value,
      contentType: file.contentType || declared,
      size: file.data.byteLength,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      available: true,
      url: attachmentUrl(packageId, submodelId, idShortPath, publicBaseUrl),
    };
  };
}

export interface DocumentRow extends FileLink {
  documentId: string | null;
  documentDomainId: string | null;
  classId: string | null;
  className: string | null;
  classificationSystem: string | null;
  version: string | null;
  language: string | null;
  title: string | null;
  status: string | null;
  statusDate: string | null;
  issuer: string | null;
}

function text(parent: Located, idShort: string, lang: string): string | null {
  return textOf(child(parent, idShort)?.element, lang);
}

/** The primary DocumentId (`DocumentIsPrimary = true`), else the first */
function primaryId(document: Located): Located | undefined {
  const ids = child(document, 'DocumentIds');
  const entries = ids ? locatedChildren(ids) : [];
  return entries.find((entry) => booleanOf(child(entry, 'DocumentIsPrimary')?.element) === true) ?? entries[0];
}

/** The VDI 2770 classification when there is one, else the first */
function classification(document: Located): Located | undefined {
  const list = child(document, 'DocumentClassifications');
  const entries = list ? locatedChildren(list) : [];
  return entries.find((entry) => /VDI\s*2770/i.test(textOf(child(entry, 'ClassificationSystem')?.element, 'en') ?? '')) ?? entries[0];
}

function compareText(a: string | null, b: string | null): number {
  return (a ?? '￿').localeCompare(b ?? '￿');
}

export function readDocuments(environment: Environment, lang: string, resolveFile: FileResolver): DocumentRow[] {
  const submodel = findSubmodel(submodelsOf(environment, shellsOf(environment)[0]), ['HandoverDocumentation'], /HandoverDocumentation|AHF578/i);
  if (!submodel) return [];
  const submodelId = String(submodel['id']);
  const list = topElements(submodel).find((item) => idShortOf(item.element) === 'Documents');
  const rows: DocumentRow[] = [];
  for (const document of list ? locatedChildren(list) : []) {
    const id = primaryId(document);
    const cls = classification(document);
    const versions = child(document, 'DocumentVersions');
    for (const version of versions ? locatedChildren(versions) : []) {
      const head = {
        documentId: id ? text(id, 'DocumentIdentifier', lang) : null,
        documentDomainId: id ? text(id, 'DocumentDomainId', lang) : null,
        classId: cls ? text(cls, 'ClassId', lang) : null,
        className: cls ? text(cls, 'ClassName', lang) : null,
        classificationSystem: cls ? text(cls, 'ClassificationSystem', lang) : null,
        version: text(version, 'Version', lang),
        language: text(version, 'Language', lang),
        title: text(version, 'Title', lang),
        status: text(version, 'StatusValue', lang),
        statusDate: text(version, 'StatusSetDate', lang),
        issuer: text(version, 'OrganizationOfficialName', lang),
      };
      const digital = child(version, 'DigitalFiles');
      const files = digital ? locatedChildren(digital).filter((item) => modelTypeOf(item.element) === 'File') : [];
      for (const file of files) rows.push({ ...head, ...resolveFile(submodelId, file.path, file.element) });
    }
  }
  return rows.sort(
    (a, b) =>
      compareText(a.documentId, b.documentId) ||
      compareText(a.version, b.version) ||
      compareText(a.language, b.language) ||
      compareText(a.fileName, b.fileName),
  );
}
