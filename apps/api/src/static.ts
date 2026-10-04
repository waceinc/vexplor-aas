/**
 * 정적 파일 서빙 — 저작 UI(@aas/web)의 빌드 결과를 API와 **같은 포트**에서 내준다.
 *
 * 왜 nginx를 따로 두지 않았나.
 *  ① 배포처가 폐쇄망 공장 서버다. 컨테이너가 하나면 반입·기동·점검이 한 번에 끝난다
 *  ② 같은 출처가 되어 CORS도, 개발용 프록시 설정도 필요 없어진다
 *  ③ 여기서 하는 일은 「파일을 그대로 준다」뿐이라, 웹서버를 들일 만큼 복잡하지 않다
 *
 * 🔴 정적 파일에는 토큰을 요구하지 않는다. 화면이 떠야 사용자가 토큰을 **넣을 수** 있다.
 *    비밀은 전부 API 쪽에 있고, 여기서 나가는 것은 누구나 받을 수 있는 앱 껍데기다.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/** 확장자 → content-type. 목록에 없으면 내주지 않는다(추측해서 내보내지 않는다) */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // 견본(public/samples) — 「견본으로 시작하기」가 받아 간다
  '.zip': 'application/zip',
  '.aasx': 'application/asset-administration-shell-package',
};

export interface StaticFile {
  path: string;
  contentType: string;
  size: number;
  /** 파일명에 해시가 박힌 것만 오래 캐시한다 */
  cacheControl: string;
}

/**
 * 요청 경로를 뿌리 안의 실제 파일로 옮긴다. 밖으로 나가면 `undefined`.
 *
 * Zip Slip과 같은 종류의 문제다(기획서 Ⅷ) — 거기서 배운 대로 **읽는 자리에서** 막는다.
 */
export async function resolveStatic(root: string, urlPath: string): Promise<StaticFile | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined; // 깨진 퍼센트 인코딩 — 해석하지 않는다
  }
  if (decoded.includes('\0')) return undefined;

  const base = resolve(root);
  // 앞의 `/`를 떼고 뿌리에 붙인다. `..`이 섞여 있어도 아래 검사에서 걸린다
  const wanted = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(join(base, wanted));
  if (candidate !== base && !candidate.startsWith(base + sep)) return undefined;

  let info;
  try {
    info = await stat(candidate);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;

  const contentType = TYPES[extname(candidate).toLowerCase()];
  if (!contentType) return undefined;

  // Vite가 assets/ 아래 파일명에 해시를 박는다 — 내용이 바뀌면 이름이 바뀌므로 오래 캐시해도 안전하다.
  // index.html은 그렇지 않다. 캐시되면 새 판을 올려도 옛 화면이 남는다
  const hashed = /[/\\]assets[/\\]/.test(candidate);
  return {
    path: candidate,
    contentType,
    size: info.size,
    cacheControl: hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
}

export function openStatic(file: StaticFile): NodeJS.ReadableStream {
  return createReadStream(file.path);
}

/** SPA 되돌림 — 없는 경로로 들어와도 앱 껍데기는 준다(새로고침·즐겨찾기 대비) */
export function isDocumentRequest(method: string, accept: string | undefined): boolean {
  return (method === 'GET' || method === 'HEAD') && (accept ?? '').includes('text/html');
}
