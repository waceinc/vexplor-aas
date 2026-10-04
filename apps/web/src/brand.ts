/**
 * 회사 표시 — 문서(.docx)에 넣을 로고 바이트.
 *
 * 로고는 `@aas/linter`의 brand 모듈에 base64로 심어 두었다(결과서 HTML도 같은 것을 쓴다).
 * 여기서는 그것을 바이트로 되돌린다 — 화면·결과서·문서가 **같은 로고 하나**를 쓴다.
 */
import { BRAND_LOGO_PNG_BASE64 } from '@aas/linter';

export function brandLogoBytes(): Uint8Array {
  const binary = atob(BRAND_LOGO_PNG_BASE64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
