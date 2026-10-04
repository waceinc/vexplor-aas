/**
 * multipart/form-data 파서.
 *
 * IDTA Part 2의 AASX 파일 서버 인터페이스가 `POST /packages`·`PUT /packages/{id}`에서
 * multipart를 요구한다(fileName · file · aasIds). 라이브러리를 들이지 않은 이유는
 * 우리가 다루는 모양이 하나뿐이고, 의존성마다 라이선스 검토가 붙기 때문이다(기획서 Ⅲ-2).
 *
 * 바이트 단위로 자른다 — 본문에 AASX(ZIP) 바이너리가 들어 있어 UTF-8로 통째 디코딩하면 깨진다.
 */

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

export class MultipartError extends Error {}

/** content-type 헤더에서 boundary를 꺼낸다 */
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
  if (!boundary) throw new MultipartError('multipart 경계(boundary)가 없습니다.');

  const delimiter = encoder.encode(`--${boundary}`);
  const parts: MultipartPart[] = [];

  let cursor = indexOfBytes(body, delimiter, 0);
  if (cursor < 0) throw new MultipartError('multipart 본문에서 경계를 찾지 못했습니다.');

  while (cursor >= 0) {
    let start = cursor + delimiter.length;
    // 마지막 경계는 '--'로 끝난다
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d) start += 1;
    if (body[start] === 0x0a) start += 1;

    const next = indexOfBytes(body, delimiter, start);
    if (next < 0) throw new MultipartError('닫히지 않은 multipart 조각이 있습니다.');

    const headerEnd = indexOfBytes(body, encoder.encode('\r\n\r\n'), start);
    if (headerEnd < 0 || headerEnd > next) throw new MultipartError('multipart 머리말이 없습니다.');

    const headerText = decoder.decode(body.subarray(start, headerEnd));
    let end = next;
    // 조각 끝의 CRLF는 경계에 속한다
    if (body[end - 1] === 0x0a) end -= 1;
    if (body[end - 1] === 0x0d) end -= 1;

    const data = body.slice(headerEnd + 4, end);
    const disposition = /content-disposition:([^\r\n]*)/i.exec(headerText)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) throw new MultipartError('이름 없는 multipart 조각이 있습니다.');

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

/** 텍스트 필드 값. 같은 이름이 여러 번 오면 전부 준다 */
export function fieldValues(parts: readonly MultipartPart[], name: string): string[] {
  return parts.filter((p) => p.name === name && p.filename === undefined).map((p) => decoder.decode(p.data));
}

export function fileOf(parts: readonly MultipartPart[], name: string): MultipartPart | undefined {
  return parts.find((p) => p.name === name && p.filename !== undefined) ?? parts.find((p) => p.name === name);
}
