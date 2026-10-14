/**
 * Template requirement levels — for each submodel of an open file, finds "mandatory / optional" from the IDTA template (2026-10-13).
 *
 * Templates are kind=Template submodels in the library (loaded from AAS_TEMPLATES_DIR at startup — templates.ts).
 * Matched by the submodel's semanticId. If there is no template, that submodel is left out of the result — the UI shows it as "unknown".
 * The judgment is made by requirements.ts in @aas/linter (a pure function).
 *
 * Important: called every time a file is opened. A per-file cache that "does not re-read if the revision is unchanged" is kept —
 *    reading every file's model each time to find templates would make opening slow when there are many files.
 */
import type { Environment } from '@aas/core';
import { collectTemplateCatalog, type TemplateRequirements } from '@aas/linter';
import type { AasStore } from '@aas/store';
import { ApiError, json } from '../http.js';
import type { Route } from '../router.js';
import { tr } from '@aas/core';

interface Cached {
  revision: number;
  templates: TemplateRequirements[];
}

/** Which file the template came from — to avoid matching a file with itself */
type Sourced = TemplateRequirements & { packageId: string };

/** Templates across the whole library — cached per file by revision */
async function templateCatalog(store: AasStore, cache: Map<string, Cached>): Promise<Map<string, Sourced>> {
  const merged = new Map<string, Sourced>();
  let cursor: string | undefined;
  do {
    const page = await store.listPackages({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const record of page.items) {
      let hit = cache.get(record.id);
      if (!hit || hit.revision !== record.revision) {
        const environment: Environment = await store.getEnvironment(record.id);
        hit = { revision: record.revision, templates: [...collectTemplateCatalog([environment]).values()] };
        cache.set(record.id, hit);
      }
      for (const template of hit.templates) {
        const current = merged.get(template.semanticId);
        if (!current || Object.keys(current.elements).length < Object.keys(template.elements).length) {
          merged.set(template.semanticId, { ...template, packageId: record.id });
        }
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return merged;
}

export function requirementRoutes(store: AasStore): Route[] {
  const cache = new Map<string, Cached>();
  return [
    {
      method: 'GET',
      pattern: '/packages/:packageId/requirements',
      async handle({ params }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const environment = await store.getEnvironment(packageId);
        const catalog = await templateCatalog(store, cache);
        const result = [];
        for (const submodel of environment.submodels ?? []) {
          const semanticId = submodel.semanticId?.keys?.[0]?.value;
          const template = semanticId ? catalog.get(semanticId) : undefined;
          if (!template) continue;
          // The template itself does not look for a match — it would be its own answer.
          // Important: do not filter by kind=Template — the submitted file's submodels are all Template too (type level)
          if (template.packageId === packageId && template.sourceId === submodel.id) continue;
          const templateFile = await store.getPackage(template.packageId);
          result.push({
            submodelId: submodel.id,
            semanticId,
            ...(template.templateIdShort ? { template: template.templateIdShort } : {}),
            ...(templateFile ? { templateFile: templateFile.name } : {}),
            elements: template.elements,
          });
        }
        return json(200, { result, templates: catalog.size });
      },
    },
  ];
}
