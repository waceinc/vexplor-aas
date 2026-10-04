/** Environment — AASX aasx/data.json의 최상위 구조 */
import type { ConceptDescription } from './concept.js';
import type { AssetAdministrationShell } from './shell.js';
import type { Submodel } from './submodel.js';

export interface Environment {
  assetAdministrationShells?: AssetAdministrationShell[];
  submodels?: Submodel[];
  conceptDescriptions?: ConceptDescription[];
}
