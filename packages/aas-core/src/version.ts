/**
 * 제품 판 번호.
 *
 * 🔴 여러 회사에 배포하면 **"어느 판을 쓰고 있는가"가 모든 문의의 첫 질문**이 된다.
 *    화면·`/health`·검증 결과서가 모두 이 값 하나를 쓴다 — 서로 다르면 그 순간 못 믿는다.
 *
 * 올릴 때: 이 파일만 고치고 `npx tsc -b` → `docker compose up -d --build`.
 *  - 규칙이 늘거나 판정이 바뀌면 → 가운데 자리(1.**1**.0)
 *  - 화면·문구만 고치면 → 끝자리(1.0.**1**)
 *  - 파일 형식이나 API가 깨지게 바뀌면 → 첫 자리(**2**.0.0)
 */
export const PRODUCT_VERSION = '1.1.0';

/**
 * 화면·문서에 함께 적는 이름 (2026-09-21 확정 → 2026-10-02 WACE에서 VEXPLOR로).
 *
 * 🔴 로고 옆에 붙을 때는 {@link PRODUCT_NAME_SHORT}를 쓴다 — 로고 그림이 이미 회사 표시라서
 *    정식 명칭을 그대로 두면 이름이 두 번 읽힌다.
 * 🔴 **로고 그림은 아직 WACE다**(packages/linter/src/docs/brand.ts). 이름만 바꿨으므로
 *    화면·결과서에서 그림과 글이 어긋난다 — VEXPLOR 로고를 받으면 그 파일을 갈아야 한다.
 */
export const PRODUCT_NAME = 'VEXPLOR AAS Studio';

/** 로고 옆·좁은 자리에 쓰는 짧은 이름 */
export const PRODUCT_NAME_SHORT = 'AAS Studio';
