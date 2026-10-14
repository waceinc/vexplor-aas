/**
 * Linter policy.
 *
 * KTL regulations and the KOSMO Validator conflict head-on in 3 places (spec §5).
 * The linter does not hide these conflicts; it lets the user choose and records the choice in findings.
 * The defaults are the approach settled on 2026-08-13 — Validator pass first, in a reversible form.
 */

export type IriConflictPolicy = 'kosmo-first' | 'idta-preserve';
export type CdDefinitionPolicy = 'require-en' | 'allow-empty';
export type LangTagPolicy = 'fix-when-evidence' | 'preserve';
/** How strictly to treat AASd-120 (no idShort on direct SML children) */
export type SmlChildIdShortPolicy = 'warn' | 'forbid' | 'allow';
/** How to treat semanticIds that point to IDTA·W3C standard terms */
export type StandardSemanticsPolicy = 'kosmo-first' | 'preserve';

export interface LinterPolicy {
  /**
   * Conflict ① — KTL §4 Note 1 requires preserving official IDTA IRIs, but KOSMO rejects admin-shell.io IRIs.
   *  kosmo-first  : IRIs outside the whitelist are errors (default)
   *  idta-preserve: official IDTA IRIs pass and are only shown as warnings
   */
  iriConflict: IriConflictPolicy;
  /**
   * Conflict ② — KTL §8 says keep it blank when there is no definition; KOSMO-CD-3 requires an English definition.
   *  require-en : error when the English definition/description is missing (default)
   *  allow-empty: allow blanks and record them only as info
   */
  cdDefinition: CdDefinitionPolicy;
  /**
   * Conflict ③ — KTL §7 says keep IDTA template errors as in the original, but language-tag typos cause AASd violations.
   *  fix-when-evidence: report duplicate language tags as errors and target them for correction (default)
   *  preserve         : show only as warnings
   */
  langTagTypo: LangTagPolicy;
  /**
   * Conflict ④ — **AASd-120**. The spec forbids idShort on direct children of a SubmodelElementList, but
   * the KOSMO Validator does not check it (absent from 4 rounds of reports). Standard tools, however, enforce it:
   * `aas-test-engines` 1.0.3 fails it as an error, and `basyx-python-sdk` cannot read the file at all.
   *
   *  warn  : warning (default) — does not block KOSMO submission but reports that interoperability breaks
   *  forbid: violation — for deployments that must load into BaSyx and pass standard tools
   *  allow : info — a deliberate choice to leave it as is
   */
  smlChildIdShort: SmlChildIdShortPolicy;
  /**
   * Conflict ⑤ — **terms from standard templates** (confirmed 2026-08-24 while adopting AID).
   *
   * IDTA standard submodel templates (AID etc.) give each element a W3C WoT·IDTA term as its semanticId, but
   * **the official templates do not ship with ConceptDescriptions** (measured on IDTA-02017: 0 CDs).
   * So KOSMO-SME-3 ("every semanticId needs a matching CD") fires once per element (61 measured).
   * Running "Fix" clears the violations, but **the standard terms get overwritten by our own IRIs and the template's meaning breaks.**
   * Meanwhile KTL modeling rule §7 requires "use IDTA standard templates as-is" — a head-on conflict.
   *
   *  kosmo-first: treat as violations (default). When the goal is KOSMO submission
   *  preserve   : keep standard terms as info only and do not correct them. When upholding KTL §7 and interoperability
   *
   * Important: there is **no measured data** on how the KOSMO Validator actually judges AID.
   * Confirm before submitting, and change this default once it is settled.
   */
  standardTemplateSemantics: StandardSemanticsPolicy;

  /** Own-IRI prefixes accepted by KOSMO */
  iriBase: string;
  /** Prefixes accepted as IRDI (eCl@ss 0173-, IEC CDD 0112/) */
  irdiPrefixes: string[];
  /**
   * Required submodel idShorts. KOSMO-AAS-4.
   * Per measurement, 4 types: DigitalNameplate·HandoverDocumentation·TechnicalData·OperationalData.
   */
  requiredSubmodels: string[];
  /** Allowed range for the total number of submodels (6 to 8 — 9 or more is a violation) */
  submodelCountRange: [min: number, max: number];
  /**
   * Submodel idShorts excluded from the Property value presence check (KOSMO-SME-4).
   * DN·HD values differ per device, so they pass even when empty at the template stage.
   */
  valueCheckExemptSubmodels: string[];
}

export const DEFAULT_POLICY: LinterPolicy = {
  iriConflict: 'kosmo-first',
  cdDefinition: 'require-en',
  langTagTypo: 'fix-when-evidence',
  smlChildIdShort: 'warn',
  standardTemplateSemantics: 'kosmo-first',
  iriBase: 'https://www.smart-factory.kr/ids',
  irdiPrefixes: ['0173-', '0112/'],
  requiredSubmodels: [
    'DigitalNameplate',
    'HandoverDocumentation',
    'TechnicalData',
    'OperationalData',
  ],
  submodelCountRange: [6, 8],
  valueCheckExemptSubmodels: ['DigitalNameplate', 'HandoverDocumentation'],
};

/** Official IDTA IRI prefixes — the subject of conflict ① */
export const IDTA_IRI_PREFIX = 'https://admin-shell.io/';

/**
 * Prefixes of standard term dictionaries — not something we create ConceptDescriptions for.
 * IDTA submodel templates and the W3C WoT·schema.org terms they build on.
 */
export const STANDARD_TERM_PREFIXES = [
  'https://admin-shell.io/idta/',
  'https://www.w3.org/',
  'http://www.w3.org/',
  'https://schema.org/',
  'http://schema.org/',
] as const;

export function isStandardTerm(value: string): boolean {
  return STANDARD_TERM_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function withPolicy(overrides: Partial<LinterPolicy> = {}): LinterPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}
