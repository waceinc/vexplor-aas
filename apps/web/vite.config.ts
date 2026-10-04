import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 개발 서버는 API(@aas/api)로 프록시한다.
 * 브라우저에서 AASX를 파싱하지 않는다는 원칙(기획서 Ⅷ — 매뉴얼이 들어가면 수백 MB)에 따라
 * 파일은 업로드만 하고 해석은 전부 서버가 한다.
 *
 * 🔴 경로를 하나씩 적지 않는다 — `/rules`·`/policy`·`/opcua-status`가 빠져 있어 개발 모드에서
 *    첫 화면에 「Unexpected token '<'」 오류 띠가 뜨고 「규칙」 화면이 비었다(2026-09-09 실측).
 *    API가 내는 최상위 경로를 한 정규식으로 잡는다. 새 경로를 서버에 더하면 여기도 더한다.
 * 🔴 대상은 127.0.0.1 — 윈도우에서 `localhost`는 ::1로 먼저 풀리는데 보호 모드 API는 IPv4에 물린다.
 */
/**
 * 🔴 대상은 `AAS_API_URL`로 바꿀 수 있다. 이 PC에는 설치판(VEXPLOR AAS Studio)이 8080을 쓰고 있어,
 *    개발 API를 다른 포트에 띄워야 할 때가 있다(2026-09-30 — 개발 화면이 설치판에 붙어 데이터가 섞였다).
 * 🔴 `bundles`(레퍼런스 번들 열기)를 더했다 — 빠지면 개발판에서만 번들 열기가 404다.
 */
const API_TARGET = process.env['AAS_API_URL'] ?? 'http://127.0.0.1:8080';
const API_PATHS =
  '^/(packages|bundles|description|health|rules|policy|opcua|opcua-status|collect-status|registry-conflicts)(?=/|$|\\?)';
const API_PROXY = { [API_PATHS]: API_TARGET };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: API_PROXY },
  preview: { port: 4173, proxy: API_PROXY },
});
