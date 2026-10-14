/**
 * Model — in-place semanticId validation (IRDI · IRI · policy).
 * Split out of src/model.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via model.ts.
 */


/**
 * semanticId format check — reduced M4 (decided in §2: direct input + validation instead of an eCl@ss search UI).
 *
 * The verdicts are based on measured rules.
 *  - KOSMO accepts only **IRDI (0173-/0112/) or our own IRI** as semanticId (02_Validator response rules §110)
 *  - eCl@ss codes ending in `-00` do not exist in CDP (AAS_OPC UA.md L9) — must be re-checked
 *  - Even with the right format, a missing matching CD is flagged as KOSMO-SME-3
 *
 * The linter catches it anyway, but **telling at the moment of input makes it cheaper to undo.**
 */
export interface SemanticIdNote {
  level: 'ok' | 'warning' | 'error';
  message: string;
}

/** eCl@ss IRDI — e.g. 0173-1#02-AAA123#001 */
const ECLASS_IRDI = String.raw`0173-\d+#\d{2}-[A-Z0-9]+#\d{3}`;

/** IEC CDD IRDI — e.g. 0112/2///61987#ABA231#009 */
const IEC_CDD_IRDI = String.raw`0112\/\d+\/\/\/[0-9_A-Za-z]+#[A-Z]{3}\d+#\d{3}`;

const ONE_IRDI = `(?:${ECLASS_IRDI}|${IEC_CDD_IRDI})`;

/**
 * Standard dictionary IRDI — **the compound form joining two with `/` is also standard** (raised by user 2026-09-14, confirmed by measurement).
 *
 * IDTA templates join "property IRDI / class IRDI" on list items (SMC) —
 * e.g. `0173-1#02-ABI500#003/0173-1#01-AHF579#003` (Document in HandoverDocumentation;
 * the first is property `#02`, the second is class `#01`).
 *
 * Important — evidence: all 4 golden files use this form **6 times each** (Documents · DocumentIds ·
 * DocumentClassifications · DocumentVersions… items), and CDs with the same ids are included.
 * Of those, `01-롤포밍기-공34.aasx` **passes every KOSMO Validator item**. The server linter
 * also checks only the prefix (`0173-`/`0112/`) and lets it through — only the UI warned "format differs from the standard",
 * flagging perfectly valid standard values.
 */
const IRDI_RE = new RegExp(`^${ONE_IRDI}(?:\\/${ONE_IRDI})?$`);

/** Is it the compound form — gives a different guidance message */
const COMPOUND_IRDI_RE = new RegExp(`^${ONE_IRDI}\\/${ONE_IRDI}$`);

export function checkSemanticId(
  value: string,
  policy: { iriBase: string; irdiPrefixes: string[] },
  hasConceptDescription: boolean,
  /** A submodel semanticId is a template IRI — same whitelist (SM-3) but no CD is required */
  scope: 'element' | 'submodel' = 'element',
  /**
   * Translator — when omitted, Korean as is.
   * Important: some sentences embed policy values, so they cannot be translated outside with `t(message)` (the prefix list in the allow-list hint).
   *    So they are translated where they are built.
   */
  t: (text: string) => string = (text) => text,
): SemanticIdNote[] {
  const trimmed = value.trim();
  if (trimmed === '') {
    return [
      {
        level: 'error',
        message: t('semanticId가 없으면 {rule} 위반입니다.').replace(
          '{rule}',
          scope === 'submodel' ? 'KOSMO-SM-3' : 'KOSMO-SME-3',
        ),
      },
    ];
  }

  const notes: SemanticIdNote[] = [];
  const isIrdiPrefix = policy.irdiPrefixes.some((prefix) => trimmed.startsWith(prefix));

  if (isIrdiPrefix) {
    if (IRDI_RE.test(trimmed)) {
      notes.push({
        level: 'ok',
        message: COMPOUND_IRDI_RE.test(trimmed)
          ? t('표준 사전 IRDI 복합형입니다 — 「속성/클래스」를 이은 형식으로, IDTA 템플릿이 리스트 항목에 씁니다.')
          : t('표준 사전 IRDI 형식입니다.'),
      });
    } else {
      notes.push({
        level: 'warning',
        message: t('IRDI 접두는 맞지만 형식이 표준과 다릅니다. 사전에서 코드를 다시 확인하십시오.'),
      });
    }
    if (/-00(#|$)/.test(trimmed)) {
      notes.push({
        level: 'warning',
        message: t('eCl@ss 말미 -00 코드는 CDP에 존재하지 않습니다. 리프 클래스까지 전개해 재확인하십시오.'),
      });
    }
  } else if (trimmed.startsWith(`${policy.iriBase}/`)) {
    notes.push({ level: 'ok', message: t('자체 IRI 규약에 맞습니다.') });
  } else if (trimmed.startsWith('https://admin-shell.io/')) {
    notes.push({
      level: 'warning',
      message: t('IDTA 공식 IRI입니다. KOSMO Validator는 이를 거부합니다(규정 충돌 ①).'),
    });
  } else {
    notes.push({
      level: 'error',
      message: t('허용 목록 밖입니다. IRDI({prefixes}) 또는 {base}/... 형식이어야 합니다.')
        .replace('{prefixes}', policy.irdiPrefixes.join(' / '))
        .replace('{base}', policy.iriBase),
    });
  }

  if (!hasConceptDescription && scope === 'element') {
    notes.push({
      level: 'warning',
      message: t('이 id를 가진 ConceptDescription이 파일에 없습니다. 「자동 고치기」가 규약대로 만들어 줍니다.'),
    });
  }
  return notes;
}
