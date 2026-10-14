/**
 * Create a new equipment scaffold.
 *
 * There is a reason we do not start from an empty AAS. The KOSMO rules **require 4 submodels and
 * bound the total count to 6-8** (KOSMO-AAS-4, 7). Starting from an empty file means a person has to
 * remember that and add them one by one, which is already possible today - no reason to build something new for it.
 * So we provide **a scaffold that follows the rules from the start** - it must have 0 violations right after creation.
 *
 * Important: conventions (iriBase, required list) are not invented here; they **come from the policy.**
 *    If a rule lives in two places, the two will inevitably diverge.
 */
import { fill, tr, type Environment } from '@aas/core';
import {
  buildEntryNode,
  hierarchyConceptDescriptions,
  HIERARCHY_SUBMODEL_ID_SHORT,
  IDTA_HIERARCHY,
} from './hierarchy.js';
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';

/**
 * Placeholder thumbnail (96x96 PNG, 220 bytes).
 *
 * KOSMO-AAS-1 **requires** `defaultThumbnail`. Without it, a newly created file starts life with
 * 1 violation, which cannot be called "a scaffold built by the rules".
 * Important: so the slot is filled, but with **a blank image that has only a border** - it must be replaced
 *    with an actual photo of the equipment. The UI tells the user so.
 */
const PLACEHOLDER_THUMBNAIL_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAo0lEQVR42u3doQ0AIAwAwe6Dw3YTJAOwv8Qhq8CQS36CW+BjzKWiQADoElDrqRMgQIAAAQIECBAgQIAAAQIECBAgQFwAAQIECBAgQIAECBAgQIAAAQIECBAgQIAAAQIECBAUQIAAAQIECBAgAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIESIAAAQIECBAgQIAAAQIECBCgP4Dk7QPoQRuIbN3SR9KX9wAAAABJRU5ErkJggg==';

/**
 * base64 -> bytes.
 * Important: uses neither `atob` (browser) nor `Buffer` (Node) - this package must **run unchanged in both**,
 *    and relying on a global breaks one side (the M3 authoring UI runs the linter in the browser).
 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const character of clean) {
    const index = BASE64_ALPHABET.indexOf(character);
    if (index < 0) continue; // Skip line breaks and the like
    held = (held << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

export const PLACEHOLDER_THUMBNAIL_PART = '/thumbnail.png';

export function placeholderThumbnail(): { part: string; contentType: string; data: Uint8Array } {
  return {
    part: PLACEHOLDER_THUMBNAIL_PART,
    contentType: 'image/png',
    data: decodeBase64(PLACEHOLDER_THUMBNAIL_BASE64),
  };
}

/**
 * What is this AAS for?
 *
 * In the standard, the target of an AAS (the Asset) is not only equipment - **processes, lines, and plants
 * are legitimate targets too** (RAMI 4.0 hierarchy: equipment -> Station -> Work Center -> plant).
 *
 * The purpose of the process unit is **to capture the actual process composition as-is** (not for Validator
 * submission - confirmed by the user 2026-08-25). So the 4 equipment-required submodels are **not added
 * automatically** to a process - the tree must start with "process -> equipment", and if the nameplate and
 * technical data show up first, it reads as just another piece of equipment rather than a process
 * (confirmed by the user 2026-08-26). Only the hierarchy (HierarchicalStructures) is added; any other
 * submodels are added later via "Add submodel".
 *
 * Important: the distinction is recorded in the standard field **AssetInformation.assetType** (an official V3.0 field).
 *    This marker is what keeps the linter from applying equipment rules such as "required 4" and "6-8 total"
 *    to a process - dropping the submodels without the marker would start life as a KOSMO-AAS-4 violation.
 */
// 'composite' is the standard name - the hierarchy is recursive, so layer names (process, company, line) are chosen by the user.
// 'process' and 'company' are kept for compatibility with existing files and the API (same structure).
export type AssetUnit = 'equipment' | 'composite' | 'process' | 'company';

export interface ScaffoldOptions {
  /** Equipment name - becomes the AAS idShort and the middle segment of every id */
  assetName: string;
  /** One piece of equipment / a process of several pieces of equipment / a company or plant of several processes. Default: equipment */
  unit?: AssetUnit;
  /** Equipment-specific submodels (safety, process, etc.). Added on top of the required 4 */
  extraSubmodels?: readonly string[];
  version?: string;
  revision?: string;
  policy?: Partial<LinterPolicy>;
}

/**
 * Added by default on top of the required 4.
 * The golden files (20 equipment types) all have it, and it is also needed to reach the minimum total count (6).
 */
export const DEFAULT_EXTRA_SUBMODELS = ['HierarchicalStructures', 'MaintenanceInstructions'];

/** Is this usable as an equipment name - it goes straight into the id, so only letters and digits are accepted */
export function isValidAssetName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

export function scaffoldEnvironment(options: ScaffoldOptions): Environment {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const name = options.assetName;
  if (!isValidAssetName(name)) {
    throw new Error(fill(tr('장비명은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: {0}'), { 0: name }));
  }

  const version = options.version ?? '1';
  const revision = options.revision ?? '0';
  const base = policy.iriBase;
  const aasId = `${base}/aas/${name}/${version}/${revision}`;
  const assetId = `${base}/asset/${name}/${version}/${revision}`;

  const unit = options.unit ?? 'equipment';
  const organizational = unit !== 'equipment';
  const wanted = organizational
    ? // For a process or company, the hierarchy is the core and the whole thing. The required 4 belong to equipment, so they are not added
      [HIERARCHY_SUBMODEL_ID_SHORT, ...(options.extraSubmodels ?? [])]
    : [...policy.requiredSubmodels, ...(options.extraSubmodels ?? DEFAULT_EXTRA_SUBMODELS)];
  // If the same name comes in twice, only the count grows and the rule breaks
  const names = [...new Set(wanted)];

  const submodels = names.map((idShort) => {
    const id = `${base}/sm/${name}/${idShort}/${version}/${revision}`;
    // Important: only the process hierarchy submodel is pre-filled. Without an entry point there is nowhere to attach children,
    //    so the user would have to build the Entity by hand, which is not what this feature is for.
    //    The equipment side is left untouched - there is no reason to change its current behavior.
    const seeded =
      organizational && idShort === HIERARCHY_SUBMODEL_ID_SHORT
        ? {
            submodelElements: [
              buildEntryNode(name, assetId, base),
              {
                idShort: 'ArcheType',
                modelType: 'Property',
                valueType: 'xs:string',
                value: 'Full',
                semanticId: {
                  type: 'ExternalReference',
                  keys: [{ type: 'GlobalReference', value: `${base}/cd/ArcheType/1/0` }],
                },
                supplementalSemanticIds: [
                  {
                    type: 'ExternalReference',
                    keys: [{ type: 'GlobalReference', value: IDTA_HIERARCHY.archeType }],
                  },
                ],
              },
            ],
          }
        : {};
    return {
      ...seeded,
      modelType: 'Submodel',
      id,
      idShort,
      // The output is per type (Type) - submodels must be Template (KOSMO-SM-4)
      kind: 'Template',
      administration: { version, revision },
      // When using our own IRI, semanticId points to its own id (KOSMO-SM-3)
      semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: id }] },
      // Important: do not write `submodelElements: []`. The V3.0 schema **does not allow empty arrays**
      //    (aas-test-engines 1.0.3: "Empty array not allowed"). If empty, the key itself must be absent.
      //    The KOSMO linter does not check this; it only surfaced after running the standard validator.
    };
  });

  return {
    assetAdministrationShells: [
      {
        modelType: 'AssetAdministrationShell',
        id: aasId,
        idShort: name,
        administration: { version, revision },
        assetInformation: {
          assetKind: 'Type',
          // Process/company marker - the basis for the linter not applying equipment rules (required 4, 6-8 total)
          ...(unit === 'composite' ? { assetType: compositeAssetType(base) } : {}),
          ...(unit === 'process' ? { assetType: processAssetType(base) } : {}),
          ...(unit === 'company' ? { assetType: companyAssetType(base) } : {}),
          globalAssetId: assetId,
          // Required by KOSMO-AAS-1. A placeholder image that must be replaced with an actual photo
          defaultThumbnail: { path: PLACEHOLDER_THUMBNAIL_PART, contentType: 'image/png' },
        },
        submodels: submodels.map((submodel) => ({
          type: 'ModelReference',
          keys: [{ type: 'Submodel', value: submodel.id }],
        })),
      },
    ],
    submodels,
    // Important: only a process also gets ConceptDescriptions, because the hierarchy elements use our own IRI
    //    (KOSMO-SME-3). The equipment scaffold has no elements and thus no semanticIds, so there is nothing to add -
    //    conceptDescriptions is not left as an empty array for the same reason as submodelElements
    ...(organizational ? { conceptDescriptions: hierarchyConceptDescriptions(base) } : {}),
  } as unknown as Environment;
}

/**
 * The AssetInformation.assetType value that marks a process/company file.
 * Important: produced in one place only - if the linter (KOSMO-AAS-4 exception) and the scaffold use different
 *    strings, the distinction silently breaks. The hierarchy is recursive (RAMI 4.0: enterprise -> plant -> station -> equipment),
 *    so a company has the same structure as a process with only a different label.
 */
export function processAssetType(iriBase: string): string {
  return `${iriBase}/type/Process`;
}

export function companyAssetType(iriBase: string): string {
  return `${iriBase}/type/Company`;
}

/** Grouping unit (shared by process, company, line) - the layer name is not fixed */
export function compositeAssetType(iriBase: string): string {
  return `${iriBase}/type/Composite`;
}

/** Is this a grouping unit (process, company, line) - a target to which equipment rules (required 4, 6-8 total) are not applied */
export function isOrganizationalAssetType(assetType: string | undefined, iriBase: string): boolean {
  return (
    assetType === compositeAssetType(iriBase) ||
    assetType === processAssetType(iriBase) ||
    assetType === companyAssetType(iriBase)
  );
}
