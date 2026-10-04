/**
 * 템플릿 폴더 — `AAS_TEMPLATES_DIR`에 둔 `.aasx`를 기동 때 보관함에 넣는다.
 *
 * 「다른 파일에서 가져오기」는 *열려 있는* 파일에서만 서브모델을 복사한다. IDTA 공식 템플릿
 * (DigitalNameplate·TechnicalData·HandoverDocumentation…)을 쓰려면 누군가 매번 먼저 올려야
 * 했다(2026-09-04 전문가 검토). 폴더에 한 번 두면 서버가 알아서 올린다.
 *
 * - 같은 **파일명**이 이미 보관함에 있으면 건너뛴다(껐다 켜도 두 벌이 안 된다).
 *   메모리 보관함은 매번 비어 있으니 매번 들어간다 — 그게 맞다.
 * - 지운 템플릿은 다음 기동 때 돌아온다. 그만 쓰려면 폴더에서 빼는 것이 맞다(문서에 적음).
 * - 🔴 IDTA 템플릿 파일은 **여기 넣어 두지 않는다** — 저장소에 동봉하려면 라이선스(CC BY 4.0
 *   표기 의무)를 먼저 확인해야 한다. 쓰는 곳이 IDTA Content Hub에서 받아 폴더에 넣는다.
 * - 업로드와 같은 `readAasx` 상한(Zip Bomb 가드)을 그대로 탄다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readAasx, type AasxLimits } from '@aas/aasx';
import type { AasStore } from '@aas/store';

export interface SeedResult {
  added: string[];
  skipped: string[];
  failed: { name: string; reason: string }[];
}

export async function seedTemplates(
  store: AasStore,
  dir: string,
  limits?: Partial<AasxLimits>,
): Promise<SeedResult> {
  const result: SeedResult = { added: [], skipped: [], failed: [] };
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => /\.aasx$/i.test(name) && statSync(join(dir, name)).isFile())
      .sort();
  } catch (error) {
    result.failed.push({ name: dir, reason: error instanceof Error ? error.message : String(error) });
    return result;
  }
  if (names.length === 0) return result;

  const present = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await store.listPackages({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) present.add(item.name);
    cursor = page.cursor;
  } while (cursor);

  for (const name of names) {
    if (present.has(name)) {
      result.skipped.push(name);
      continue;
    }
    try {
      const pkg = readAasx(new Uint8Array(readFileSync(join(dir, name))), limits ? { limits } : {});
      await store.importPackage({ name, package: pkg });
      result.added.push(name);
    } catch (error) {
      result.failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
