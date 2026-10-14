/**
 * Company mark — logo bytes to embed in documents (.docx).
 *
 * The logo is embedded as base64 in the brand module of `@aas/linter` (the HTML report uses the same one).
 * Here it is turned back into bytes — screen, report and document all use **one and the same logo**.
 */
import { BRAND_LOGO_PNG_BASE64 } from '@aas/linter';

export function brandLogoBytes(): Uint8Array {
  const binary = atob(BRAND_LOGO_PNG_BASE64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
