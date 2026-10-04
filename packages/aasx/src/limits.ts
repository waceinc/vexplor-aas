/**
 * 압축 폭탄(Zip Bomb)·경로 탈출(Zip Slip) 방어 — 기획서 Ⅷ 보안 항목.
 *
 * 업로드를 받는 순간부터 실존하는 위험이다. 다행히 fflate의 `unzipSync`는 **중앙 디렉터리가
 * 선언한 원본 크기(`originalSize`)만큼만 출력 버퍼를 잡는다**(`inflateSync(..., { out: new u8(su) })`).
 * 그래서 **압축을 풀기 전에 filter에서 막으면 메모리 폭발이 원천 차단된다** — 헤더가 거짓말을 해도
 * 그 크기 이상은 할당되지 않고, 스트림이 넘치면 inflate가 스스로 실패한다.
 *
 * 경로는 지금 당장은 메모리에만 남지만, 재저장·첨부 추출처럼 **디스크에 쓰는 경로가 생기면
 * 그때는 늦다.** 읽는 자리에서 한 번 막아 둔다.
 */

export interface AasxLimits {
  /** 풀었을 때 전체 크기 상한. 기본 512MB — 매뉴얼이 든 AASX를 감안한 값(기획서 Ⅷ) */
  maxTotalUncompressedBytes: number;
  /** 파트 하나의 상한. 기본 256MB */
  maxEntryUncompressedBytes: number;
  /** 파트 개수 상한. 작은 파일 수십만 개로 부풀리는 수법을 막는다 */
  maxEntries: number;
}

export const DEFAULT_LIMITS: AasxLimits = {
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
};

/** 상한을 넘었거나 경로가 위험한 경우. 파일 형식 오류(AasxReadError)와 구분한다 */
export class AasxLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AasxLimitError';
  }
}

/**
 * ZIP 엔트리 이름이 안전한지.
 *
 * 막는 것: 상위 경로 탈출(`..`), 절대경로, 드라이브 문자(`C:`), UNC(`//server`), 널 바이트.
 * 역슬래시는 윈도에서 경로 구분자가 되므로 슬래시와 같게 본다.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.includes('\0')) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

/**
 * unzipSync에 넘길 필터. 압축을 풀기 **전에** 판정한다.
 * 상한을 넘으면 예외를 던져 그 자리에서 멈춘다 — 나머지를 마저 푸는 것 자체가 위험이다.
 */
export function createEntryGuard(limits: AasxLimits): (file: {
  name: string;
  originalSize: number;
}) => boolean {
  let total = 0;
  let count = 0;

  return (file) => {
    if (!isSafeEntryName(file.name)) {
      throw new AasxLimitError(`안전하지 않은 파트 경로입니다: ${file.name}`);
    }

    count += 1;
    if (count > limits.maxEntries) {
      throw new AasxLimitError(`파트 개수가 상한(${limits.maxEntries}개)을 넘었습니다.`);
    }

    if (file.originalSize > limits.maxEntryUncompressedBytes) {
      throw new AasxLimitError(
        `파트 하나가 상한을 넘었습니다: ${file.name} — ` +
          `${file.originalSize}바이트 (상한 ${limits.maxEntryUncompressedBytes})`,
      );
    }

    total += file.originalSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new AasxLimitError(
        `풀었을 때 크기가 상한(${limits.maxTotalUncompressedBytes}바이트)을 넘었습니다. ` +
          '압축 폭탄일 수 있습니다.',
      );
    }

    return true;
  };
}
