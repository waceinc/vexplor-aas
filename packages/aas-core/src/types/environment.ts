/** Environment — top-level structure of AASX aasx/data.json */
import type { ConceptDescription } from './concept.js';
import type { AssetAdministrationShell } from './shell.js';
import type { Submodel } from './submodel.js';

export interface Environment {
  assetAdministrationShells?: AssetAdministrationShell[];
  submodels?: Submodel[];
  conceptDescriptions?: ConceptDescription[];
}
