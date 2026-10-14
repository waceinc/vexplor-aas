/** AssetAdministrationShell and AssetInformation */
import type {
  AssetKind,
  HasDataSpecification,
  Identifiable,
  Reference,
} from './common.js';
import type { SpecificAssetId } from './submodel.js';

export interface Resource {
  path: string;
  contentType?: string;
}

export interface AssetInformation {
  /** KOSMO-AAS-6: must be Type */
  assetKind: AssetKind;
  /** AASd-131: at least one of globalAssetId or specificAssetIds is required */
  globalAssetId?: string;
  specificAssetIds?: SpecificAssetId[];
  assetType?: string;
  /** KOSMO-AAS-1: must match the thumbnail part path inside the package */
  defaultThumbnail?: Resource;
}

export interface AssetAdministrationShell extends Identifiable, HasDataSpecification {
  modelType: 'AssetAdministrationShell';
  assetInformation: AssetInformation;
  derivedFrom?: Reference;
  /** List of ModelReferences to Submodels */
  submodels?: Reference[];
}
