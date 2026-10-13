/**
 * API 클라이언트.
 *
 * 서버 경로는 IDTA Part 2를 따른다(docs/spec/part2/). 식별자는 base64url로 인코딩해 넣는다.
 * 파일 해석은 전부 서버가 한다 — 브라우저는 바이트를 올리고 결과를 받을 뿐이다(기획서 Ⅷ).
 *
 * 2026-10-13 컴포넌트화 — 주제별로 api/ 에 나눴다(타입 · 요청 틀 · 로그인 · 파일 · 모델 편집 · 문서용 자료 · 첨부 ·
 * 수집 · 번들 · 형식 반영). 쓰는 쪽은 예전처럼 이 파일에서 api 와 타입을 가져온다.
 */
import { attachmentApi } from './api/attachments.js';
import { authApi } from './api/auth.js';
import { bundleApi } from './api/bundles.js';
import { collectionApi } from './api/collection.js';
import { derivationApi } from './api/derivation.js';
import { docsApi } from './api/docs.js';
import { documentApi } from './api/document.js';
import { modelApi } from './api/model.js';

export * from './api/types.js';
export { ApiError, ConflictError, ForbiddenError, UnauthorizedError, currentToken, encodeIdentifier, setToken } from './api/http.js';

export const api = {
  ...authApi,
  ...documentApi,
  ...modelApi,
  ...docsApi,
  ...attachmentApi,
  ...collectionApi,
  ...bundleApi,
  ...derivationApi,
};
