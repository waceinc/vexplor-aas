/**
 * OPC(Open Packaging Conventions) 파트 처리.
 *
 * AASX는 OPC ZIP이며, 다음 3곳이 서로 정합해야 파일이 유효하다(린터 명세 PKG-THUMB-PART):
 *   ① 실제 파트(ZIP 엔트리)  ② _rels 관계 선언  ③ [Content_Types].xml Override
 * 하나라도 빠지면 Package Explorer는 열지만 Validator는 떨어뜨린다.
 */
import { XMLParser } from 'fast-xml-parser';

export const REL_TYPE = {
  origin: 'http://admin-shell.io/aasx/relationships/aasx-origin',
  spec: 'http://admin-shell.io/aasx/relationships/aas-spec',
  suppl: 'http://admin-shell.io/aasx/relationships/aas-suppl',
  thumbnail: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
} as const;

export const NS = {
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  relationships: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const;

export const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';

export interface Relationship {
  id: string;
  type: string;
  /** 절대 파트명(선행 '/' 포함)으로 정규화해 보관한다 */
  target: string;
  targetMode?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  trimValues: true,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** 상대 Target을 소유 파트 기준 절대 파트명으로 바꾼다 */
export function resolveTarget(target: string, ownerDir: string): string {
  if (target.startsWith('/')) return target;
  const base = ownerDir.endsWith('/') ? ownerDir : `${ownerDir}/`;
  const segments = `${base}${target}`.split('/');
  const out: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return `/${out.join('/')}`;
}

/** .rels XML을 파싱한다. ownerDir은 관계 파일이 기술하는 파트가 있는 디렉터리('/' 또는 '/aasx') */
export function parseRelationships(xml: string, ownerDir: string): Relationship[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = doc['Relationships'] as Record<string, unknown> | undefined;
  if (!root) return [];
  return asArray(root['Relationship'] as Record<string, string> | Record<string, string>[])
    .map((r) => {
      const rel: Relationship = {
        id: r['@Id'] ?? '',
        type: r['@Type'] ?? '',
        target: resolveTarget(r['@Target'] ?? '', ownerDir),
      };
      const mode = r['@TargetMode'];
      if (mode !== undefined) rel.targetMode = mode;
      return rel;
    });
}

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPE[c] ?? c);
}

/** .rels XML을 생성한다. 골든 파일과 동일한 속성 순서(Target, Id, Type, TargetMode)를 따른다 */
export function buildRelationships(rels: Relationship[]): string {
  const items = rels
    .map((r) => {
      const mode = r.targetMode ?? 'Internal';
      return (
        `<Relationship Target="${escapeXml(r.target)}" Id="${escapeXml(r.id)}"` +
        ` Type="${escapeXml(r.type)}" TargetMode="${escapeXml(mode)}"></Relationship>`
      );
    })
    .join('');
  return `<?xml version='1.0' encoding='UTF-8'?>\n<Relationships xmlns="${NS.relationships}">${items}</Relationships>`;
}

export interface ContentTypes {
  /** 확장자(소문자, '.' 제외) → MIME */
  defaults: Map<string, string>;
  /** 절대 파트명 → MIME */
  overrides: Map<string, string>;
}

export function parseContentTypes(xml: string): ContentTypes {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = doc['Types'] as Record<string, unknown> | undefined;
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  if (!root) return { defaults, overrides };

  for (const d of asArray(root['Default'] as Record<string, string> | Record<string, string>[])) {
    const ext = d['@Extension'];
    const ct = d['@ContentType'];
    if (ext && ct) defaults.set(ext.toLowerCase(), ct);
  }
  for (const o of asArray(root['Override'] as Record<string, string> | Record<string, string>[])) {
    const part = o['@PartName'];
    const ct = o['@ContentType'];
    if (part && ct) overrides.set(part, ct);
  }
  return { defaults, overrides };
}

export function buildContentTypes(ct: ContentTypes): string {
  const defaults = [...ct.defaults]
    .map(([ext, type]) => `<Default Extension="${escapeXml(ext)}" ContentType="${escapeXml(type)}"></Default>`)
    .join('');
  const overrides = [...ct.overrides]
    .map(([part, type]) => `<Override PartName="${escapeXml(part)}" ContentType="${escapeXml(type)}"></Override>`)
    .join('');
  return `<?xml version='1.0' encoding='UTF-8'?>\n<Types xmlns="${NS.contentTypes}">${defaults}${overrides}</Types>`;
}

/** 파트에 적용되는 MIME을 돌려준다 (Override 우선, 없으면 확장자 Default) */
export function contentTypeOf(ct: ContentTypes, partName: string): string | undefined {
  const override = ct.overrides.get(partName);
  if (override !== undefined) return override;
  const dot = partName.lastIndexOf('.');
  if (dot < 0) return undefined;
  return ct.defaults.get(partName.slice(dot + 1).toLowerCase());
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp',
  pdf: 'application/pdf', json: 'application/json', xml: 'application/xml',
  txt: 'text/plain', csv: 'text/csv', html: 'text/html',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

export function guessContentType(partName: string): string {
  const dot = partName.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT[partName.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** ZIP 엔트리명('aasx/data.json') → 절대 파트명('/aasx/data.json') */
export function toPartName(entry: string): string {
  return entry.startsWith('/') ? entry : `/${entry}`;
}

/** 절대 파트명('/aasx/data.json') → ZIP 엔트리명('aasx/data.json') */
export function toEntryName(part: string): string {
  return part.startsWith('/') ? part.slice(1) : part;
}

/** 파트의 관계 파일 경로를 돌려준다. '/aasx/data.json' → '/aasx/_rels/data.json.rels' */
export function relsPathFor(part: string): string {
  const idx = part.lastIndexOf('/');
  const dir = part.slice(0, idx);
  const name = part.slice(idx + 1);
  return `${dir}/_rels/${name}.rels`;
}

/** 관계 파일이 기술하는 대상 디렉터리. '/aasx/_rels/data.json.rels' → '/aasx' */
export function ownerDirOfRels(relsPart: string): string {
  const idx = relsPart.indexOf('/_rels/');
  return idx <= 0 ? '/' : relsPart.slice(0, idx);
}
