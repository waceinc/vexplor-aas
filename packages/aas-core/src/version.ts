/**
 * Product version number.
 *
 * Important: once deployed to multiple companies, **"which version are you on" becomes the first question in
 *    every inquiry.** The UI, `/health`, and validation reports all use this single value — the moment they
 *    differ, none can be trusted.
 *
 * To bump: edit only this file, then `npx tsc -b` → `docker compose up -d --build`.
 *  - Rules added or judgments changed → middle digit (1.**1**.0)
 *  - Only UI or wording fixed → last digit (1.0.**1**)
 *  - File format or API changed in a breaking way → first digit (**2**.0.0)
 */
export const PRODUCT_VERSION = '2.0.1';

/**
 * Name shown on screens and documents (set 2026-09-21 → changed from WACE to VEXPLOR on 2026-10-02).
 *
 * Important: next to the logo, use {@link PRODUCT_NAME_SHORT} — the logo image already identifies the company,
 *    so keeping the full name would make the name read twice.
 * Important: **the logo image is still WACE** (packages/linter/src/docs/brand.ts). Only the name changed, so
 *    image and text disagree on screens and reports — replace that file once the VEXPLOR logo is received.
 */
export const PRODUCT_NAME = 'VEXPLOR AAS Studio';

/** Short name used next to the logo and in narrow spaces */
export const PRODUCT_NAME_SHORT = 'AAS Studio';
