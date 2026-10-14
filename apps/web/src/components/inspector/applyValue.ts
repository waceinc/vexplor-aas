/**
 * 서브모델 JSON 에 값 하나를 얹는다 — 값 표(BulkValues)와 CSV 채우기(csvfill)가 함께 쓴다.
 * 경로는 idShort 를 점(.)으로 이은 것. MLP 는 첫 언어, Range 는 「min~max」 글자로 받는다.
 * 경로가 없으면 아무것도 하지 않는다(false).
 */
export function applyValue(holder: Record<string, unknown>, path: string, value: string): boolean {
  const segments = path.split('.');
  let cursor: Record<string, unknown> | undefined = holder;
  for (let index = 0; index < segments.length; index += 1) {
    const list = (cursor?.['submodelElements'] ?? cursor?.['value'] ?? cursor?.['statements']) as Record<string, unknown>[] | undefined;
    cursor = Array.isArray(list) ? list.find((element) => element['idShort'] === segments[index]) : undefined;
    if (!cursor) return false;
  }
  if (cursor['modelType'] === 'MultiLanguageProperty') {
    const list = (cursor['value'] as { language: string; text: string }[]) ?? [];
    if (list.length > 0) list[0]!.text = value;
    else cursor['value'] = [{ language: 'ko', text: value }];
  } else if (cursor['modelType'] === 'Range') {
    const [min, max] = value.split('~');
    cursor['min'] = (min ?? '').trim();
    cursor['max'] = (max ?? '').trim();
  } else {
    cursor['value'] = value;
  }
  return true;
}
