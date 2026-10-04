/**
 * 파일 복제 — 「호기별로 나누기」의 실체.
 *
 * 롤포밍기 ×2를 호기별로 나누면 사용자가 원하는 것은 **서브모델까지 그대로 든**
 * RollFormingMachine_1·_2 파일이다(실측 제보: "기존 장비파일에 작성되어 있는
 * 서브모델은 안딸려오네", 2026-08-27). 이름만 단 빈 마디로는 부족하다.
 *
 * 복제는 겉보기 복사가 아니라 **개명**이다 — id를 그대로 두면 두 파일이 같은
 * id를 주장해 레지스트리·저장소에서 충돌한다. 바꾸는 것:
 *   - AAS idShort → 새 이름
 *   - AAS id · Asset 주소 · 서브모델 id → 옛 이름 자리를 새 이름으로
 *   - 위 id를 가리키는 모든 참조(Reference.keys[].value) → 새 id로
 *
 * ConceptDescription은 바꾸지 않는다 — 개념은 호기가 달라도 같은 개념이다
 * (cd id는 idShort 기반이라 장비명이 들어 있지 않다).
 */
import type { Environment } from '@aas/core';

interface Identifiable {
  id?: string;
  idShort?: string;
  assetInformation?: { globalAssetId?: string };
}

/** 옛 id 안의 장비명 조각을 새 이름으로 바꾼다. 규약 밖 id면 표준 꼴로 새로 짓는다 */
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

/** 환경 전체를 돌며 옛 id와 정확히 같은 문자열을 새 id로 바꾼다 (참조 포함) */
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
  if (!shell) throw new Error('복제할 파일에 AAS가 없습니다.');
  const oldName = shell.idShort ?? '';
  if (oldName === '') throw new Error('복제할 파일의 AAS에 idShort가 없습니다.');

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
    // 🔴 어디서 나왔는지 표준 필드로 남긴다(AAS 메타모델 derivedFrom — 파생된 AAS → 원본 AAS).
    //    이것이 없으면 호기에서 모은 수집값을 원본(형식) 모델의 증빙으로 이을 길이 없다
    //    (레퍼런스 번들 증빙, 2026-09-30). 원본이 이미 무엇에서 파생됐다면 그 끈은 원본 쪽 것이라 덮어쓴다
    if (shell.id) {
      (renamedShell as Record<string, unknown>)['derivedFrom'] = {
        type: 'ModelReference',
        keys: [{ type: 'AssetAdministrationShell', value: shell.id }],
      };
    }
  }
  return renamed as unknown as Environment;
}
