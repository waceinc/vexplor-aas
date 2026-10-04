/** AssetAdministrationShell 및 AssetInformation */
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
  /** KOSMO-AAS-6: Type 이어야 한다 */
  assetKind: AssetKind;
  /** AASd-131: globalAssetId 또는 specificAssetIds 중 하나 이상 필요 */
  globalAssetId?: string;
  specificAssetIds?: SpecificAssetId[];
  assetType?: string;
  /** KOSMO-AAS-1: 패키지 내 썸네일 파트 경로와 일치해야 한다 */
  defaultThumbnail?: Resource;
}

export interface AssetAdministrationShell extends Identifiable, HasDataSpecification {
  modelType: 'AssetAdministrationShell';
  assetInformation: AssetInformation;
  derivedFrom?: Reference;
  /** Submodel에 대한 ModelReference 목록 */
  submodels?: Reference[];
}
