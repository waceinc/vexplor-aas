/**
 * 값 표의 「구분」 — 항목마다 필수 · 수집으로 채움 · 선택 · 모름(2026-10-13).
 *
 * 개념은 digital-twin 실운영에서 왔다 — 템플릿 전체를 두고 「쓰는 항목」만 켜 보여, 처음 쓰는 사람이 수십 칸 앞에서
 * 멈추지 않게 한다(digital-twin_AAS_참조분석_2026-10-13.md §2-2).
 * 🔴 모르는 것을 지어내지 않는다 — 템플릿이 없거나 템플릿에 없는 항목은 「모름」이다(필수라고도 선택이라고도 하지 않는다).
 */
import { normalizeElementPath } from '@aas/linter';
import type { SubmodelRequirement } from '../../api.js';

export type Need = 'required' | 'collected' | 'optional' | 'unknown';

/**
 * 수집 연결(AID)에 같은 이름이 있으면 「수집」이 먼저다 — 필수여도 사람이 채울 칸이 아니다.
 * (수집값을 모델에 얹는 규칙 — 이름이 맞아야 — 과 같은 기준이다: collection/LiveMap)
 */
export function needOf(
  path: string,
  idShort: string,
  requirement: SubmodelRequirement | undefined,
  collectedNames: ReadonlySet<string> | undefined,
): Need {
  if (collectedNames?.has(idShort)) return 'collected';
  const element = requirement?.elements[normalizeElementPath(path)];
  if (!element) return 'unknown';
  return element.required ? 'required' : 'optional';
}
