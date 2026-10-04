/** AASX 패키지 인메모리 모델 */
import type { Environment } from '@aas/core';

export interface AasxFile {
  /** 절대 파트명 (예: '/aasx/suppl/manual.pdf') */
  part: string;
  contentType: string;
  data: Uint8Array;
}

export interface AasxPackage {
  environment: Environment;
  /** AAS 본문 파트명. 기본 '/aasx/data.json' */
  specPart: string;
  /** 패키지 썸네일. AssetInformation.defaultThumbnail.path와 경로가 일치해야 한다(KOSMO-AAS-1) */
  thumbnail?: AasxFile;
  /** data.json에 aas-suppl 관계로 연결된 첨부 파일(매뉴얼 등) */
  supplementaryFiles: AasxFile[];
  /**
   * 우리가 관리하지 않는 나머지 ZIP 엔트리.
   * 무손실 왕복을 위해 읽은 그대로 보관했다가 다시 써 넣는다.
   */
  extraParts: Map<string, Uint8Array>;
}

export const DEFAULT_SPEC_PART = '/aasx/data.json';
export const ORIGIN_PART = '/aasx/aasx-origin';
