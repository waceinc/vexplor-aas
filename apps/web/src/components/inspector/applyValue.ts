/**
 * Sets one value in a submodel JSON — shared by the value table (BulkValues) and fill-from-CSV (csvfill).
 * The path is idShorts joined with dots (.). MLP takes the first language, Range takes "min~max" text.
 * Does nothing when the path does not exist (false).
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
