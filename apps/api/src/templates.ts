/**
 * Templates folder — `.aasx` files placed in `AAS_TEMPLATES_DIR` are put into the library at startup.
 *
 * "Import from another file" copies submodels only from *open* files. To use the official IDTA templates
 * (DigitalNameplate·TechnicalData·HandoverDocumentation…) someone had to upload them first every
 * time (expert review 2026-09-04). Put them in the folder once and the server uploads them by itself.
 *
 * - If a file with the same **file name** is already in the library, it is skipped (restarts do not create duplicates).
 *   The in-memory library starts empty each time, so they go in each time — that is correct.
 * - Deleted templates come back at the next startup. To stop using one, remove it from the folder (documented).
 * - Important: IDTA template files are **not bundled here** — bundling them in the repository requires checking the license (CC BY 4.0
 *   attribution requirement) first. Deployers download them from the IDTA Content Hub and put them in the folder.
 * - Goes through the same `readAasx` cap (Zip Bomb guard) as uploads.
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
