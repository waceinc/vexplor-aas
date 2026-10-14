/**
 * File cloning - what "split by unit" actually does.
 *
 * When roll forming machine x2 is split by unit, what the user wants is RollFormingMachine_1 and _2 files
 * **with the submodels carried over as-is** (field report: "the submodels written in the existing equipment file
 * don't come along", 2026-08-27). Empty nodes with just a name are not enough.
 *
 * Cloning is not a surface copy but a **rename** - if the id is kept, both files claim the same
 * id and collide in the registry and repository. What changes:
 *   - AAS idShort -> new name
 *   - AAS id, Asset address, submodel id -> old name segment replaced with the new name
 *   - every reference pointing to those ids (Reference.keys[].value) -> the new id
 *
 * ConceptDescriptions are not changed - a concept is the same concept across units
 * (cd ids are idShort-based and do not contain the equipment name).
 */
import { tr, type Environment } from '@aas/core';

interface Identifiable {
  id?: string;
  idShort?: string;
  assetInformation?: { globalAssetId?: string };
}

/** Replace the equipment-name segment of the old id with the new name. Ids outside the convention are rebuilt in the standard form */
function renameId(
  id: string,
  kind: 'aas' | 'sm' | 'asset',
  oldName: string,
  newName: string,
  iriBase: string,
  tail: string,
): string {
  const seg = `/${kind}/${oldName}/`;
  if (id.includes(seg)) return id.replace(seg, `/${kind}/${newName}/`);
  return `${iriBase}/${kind}/${newName}/${tail}`;
}

/** Walk the whole environment and replace strings exactly equal to the old id with the new id (including references) */
function replaceIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceIds(item, map));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceIds(item, map);
    }
    return out;
  }
  return value;
}

export function renameEnvironment(
  environment: Environment,
  newName: string,
  iriBase: string,
): Environment {
  const env = JSON.parse(JSON.stringify(environment)) as Record<string, unknown>;
  const shells = (env['assetAdministrationShells'] ?? []) as Identifiable[];
  const submodels = (env['submodels'] ?? []) as Identifiable[];
  const shell = shells[0];
  if (!shell) throw new Error(tr('복제할 파일에 AAS가 없습니다.'));
  const oldName = shell.idShort ?? '';
  if (oldName === '') throw new Error(tr('복제할 파일의 AAS에 idShort가 없습니다.'));

  const map = new Map<string, string>();
  if (shell.id) map.set(shell.id, renameId(shell.id, 'aas', oldName, newName, iriBase, '1/0'));
  const asset = shell.assetInformation?.globalAssetId;
  if (asset) map.set(asset, renameId(asset, 'asset', oldName, newName, iriBase, '1/0'));
  for (const submodel of submodels) {
    if (!submodel.id) continue;
    map.set(
      submodel.id,
      renameId(submodel.id, 'sm', oldName, newName, iriBase, `${submodel.idShort ?? 'Submodel'}/1/0`),
    );
  }

  const renamed = replaceIds(env, map) as Record<string, unknown>;
  const renamedShell = ((renamed['assetAdministrationShells'] ?? []) as Identifiable[])[0];
  if (renamedShell) {
    renamedShell.idShort = newName;
    // Important: record the origin in a standard field (AAS metamodel derivedFrom - derived AAS -> original AAS).
    //    Without it there is no way to link values collected from a unit back to the original (type) model as evidence
    //    (reference bundle evidence, 2026-09-30). If the original itself was derived from something, that link is the original's, so overwrite it
    if (shell.id) {
      (renamedShell as Record<string, unknown>)['derivedFrom'] = {
        type: 'ModelReference',
        keys: [{ type: 'AssetAdministrationShell', value: shell.id }],
      };
    }
  }
  return renamed as unknown as Environment;
}
