/**
 * API client.
 *
 * Server paths follow IDTA Part 2 (docs/spec/part2/). Identifiers are base64url-encoded into the path.
 * All file parsing happens on the server — the browser only uploads bytes and receives results (plan doc VIII).
 *
 * 2026-10-13 componentization — split by topic into api/ (types · request wrapper · login · files · model editing · document data · attachments ·
 * collection · bundles · type derivation). Callers still import api and the types from this file as before.
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
