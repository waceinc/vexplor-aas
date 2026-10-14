/**
 * 템플릿 요구 수준 — 열린 파일의 서브모델마다 「필수 · 선택」을 IDTA 템플릿에서 찾아 준다(2026-10-13).
 *
 * 템플릿은 보관함에 들어 있는 kind=Template 서브모델이다(AAS_TEMPLATES_DIR 에서 기동 때 올라온 것 — templates.ts).
 * 서브모델의 semanticId 로 짝을 짓는다. 템플릿이 없으면 그 서브모델은 결과에서 빠진다 — 화면은 「모름」으로 둔다.
 * 판정은 @aas/linter 의 requirements.ts(순수 함수)가 한다.
 *
 * 🔴 파일을 열 때마다 불린다. 보관함의 파일마다 「리비전이 같으면 다시 읽지 않는」 캐시를 둔다 —
 *    템플릿을 찾느라 매번 모든 파일의 모델을 읽으면 파일이 많을 때 열기가 느려진다.
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

/** 어느 파일에서 온 템플릿인가 — 제 자신과 짝짓지 않으려고 */
type Sourced = TemplateRequirements & { packageId: string };

/** 보관함 전체의 템플릿 — 파일마다 리비전으로 캐시한다 */
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
          // 템플릿 자신은 짝을 찾지 않는다 — 제 자신이 답이 된다.
          // 🔴 kind=Template 으로 거르면 안 된다 — 제출 파일의 서브모델도 모두 Template 이다(형식 단위)
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
