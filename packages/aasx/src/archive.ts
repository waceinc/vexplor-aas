/**
 * AASX가 아닌 **일반 ZIP** — 레퍼런스 번들 꾸러미용.
 *
 * AASX는 OPC 규약(Content_Types·관계)이 붙은 ZIP이라 readAasx/writeAasx가 따로 있다.
 * 번들은 AASX 여러 개와 문서·표를 폴더째 담는 평범한 ZIP이다. 같은 fflate를 쓰되
 * **압축 폭탄·경로 탈출 방어는 AASX와 똑같이** 건다(기획서 Ⅷ) — 번들도 남이 준 파일이다.
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { AasxLimitError, createEntryGuard, DEFAULT_LIMITS, type AasxLimits } from './limits.js';
import { DETERMINISTIC_MTIME } from './write.js';

export class ArchiveReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveReadError';
  }
}

/**
 * 경로 → 바이트를 ZIP으로 묶는다. 경로는 `/`로 구분한다.
 * 수정시각을 고정해 **같은 내용이면 같은 바이트**가 나온다 — 번들 해시를 재현할 수 있어야 한다.
 */
export function zipArchive(files: Record<string, Uint8Array>, mtime = DETERMINISTIC_MTIME): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, data] of Object.entries(files)) {
    // 이미 압축된 AASX는 다시 압축하지 않는다 — 시간만 든다
    zippable[path] = [data, { level: /\.(aasx|zip|png|jpe?g)$/i.test(path) ? 0 : 6, mtime }];
  }
  return zipSync(zippable, { mtime });
}

/** ZIP을 푼다. 상한·위험 경로는 풀기 전에 막는다. 디렉터리 엔트리는 뺀다 */
export function unzipArchive(buffer: Uint8Array, limits: Partial<AasxLimits> = {}): Record<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buffer, { filter: createEntryGuard({ ...DEFAULT_LIMITS, ...limits }) });
  } catch (e) {
    if (e instanceof AasxLimitError) throw e;
    throw new ArchiveReadError(`ZIP을 열 수 없습니다: ${(e as Error).message}`);
  }
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (!name.endsWith('/')) out[name] = data;
  }
  return out;
}
