import { tr } from '@aas/core';
/**
 * multipart/form-data parser.
 *
 * IDTA Part 2's AASX file server interface requires multipart for `POST /packages` and `PUT /packages/{id}`
 * (fileName · file · aasIds). Why no library:
 * we handle only one shape, and every dependency brings a license review (plan Ⅲ-2).
 *
 * Split at the byte level — the body contains AASX (ZIP) binary, which breaks if decoded wholesale as UTF-8.
 */

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

export class MultipartError extends Error {}

/** Extract the boundary from the content-type header */
export function boundaryOf(contentType: string): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  return value?.trim();
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function parseMultipart(body: Uint8Array, contentType: string): MultipartPart[] {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new MultipartError(tr('multipart 경계(boundary)가 없습니다.'));

  const delimiter = encoder.encode(`--${boundary}`);
  const parts: MultipartPart[] = [];

  let cursor = indexOfBytes(body, delimiter, 0);
  if (cursor < 0) throw new MultipartError(tr('multipart 본문에서 경계를 찾지 못했습니다.'));

  while (cursor >= 0) {
    let start = cursor + delimiter.length;
    // The final boundary ends with '--'
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d) start += 1;
    if (body[start] === 0x0a) start += 1;

    const next = indexOfBytes(body, delimiter, start);
    if (next < 0) throw new MultipartError(tr('닫히지 않은 multipart 조각이 있습니다.'));

    const headerEnd = indexOfBytes(body, encoder.encode('\r\n\r\n'), start);
    if (headerEnd < 0 || headerEnd > next) throw new MultipartError(tr('multipart 머리말이 없습니다.'));

    const headerText = decoder.decode(body.subarray(start, headerEnd));
    let end = next;
    // The CRLF at the end of a part belongs to the boundary
    if (body[end - 1] === 0x0a) end -= 1;
    if (body[end - 1] === 0x0d) end -= 1;

    const data = body.slice(headerEnd + 4, end);
    const disposition = /content-disposition:([^\r\n]*)/i.exec(headerText)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) throw new MultipartError(tr('이름 없는 multipart 조각이 있습니다.'));

    const part: MultipartPart = { name, data };
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    if (filename) part.filename = filename;
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1];
    if (partType) part.contentType = partType.trim();

    parts.push(part);
    cursor = next;
  }

  return parts;
}

/** Text field values. If the same name appears several times, all are returned */
export function fieldValues(parts: readonly MultipartPart[], name: string): string[] {
  return parts.filter((p) => p.name === name && p.filename === undefined).map((p) => decoder.decode(p.data));
}

export function fileOf(parts: readonly MultipartPart[], name: string): MultipartPart | undefined {
  return parts.find((p) => p.name === name && p.filename !== undefined) ?? parts.find((p) => p.name === name);
}
