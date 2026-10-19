/**
 * Official IDTA templates for a Digital Product Passport — offered next to "Start with a sample".
 *
 * The files are shipped unmodified in public/samples/idta (CC BY 4.0 — attribution in public/samples/idta/NOTICE.md and
 * THIRD-PARTY-NOTICES.md). Opening one uploads it like any AASX the user picks, so it reads, checks and saves the same way.
 *
 * Important: the list order is the order on screen — the generic passport metadata (IDTA 02099-1) first, because every
 *    passport needs it; the battery passport parts follow in their own numbering.
 * Important: the wording stops at "write and check passport data". Opening these files does not make a product
 *    compliant with the EU DPP rules (access rights, data carriers and the security part are outside this tool).
 */
import { fill, tr } from '../i18n.js';

export interface DppTemplate {
  /** File name in public/samples/idta */
  file: string;
  /** IDTA specification number */
  spec: string;
  version: string;
  label: string;
}

export function dppTemplates(): DppTemplate[] {
  return [
    { file: 'IDTA-02099-1_DigitalProductPassport_1.0.2.aasx', spec: 'IDTA 02099-1', version: '1.0.2', label: tr('제품 여권 메타데이터 (DPP Part 1)') },
    { file: 'IDTA-02035-1_BatteryPassport_DigitalNameplate_1.1.aasx', spec: 'IDTA 02035-1', version: '1.1', label: tr('배터리 여권 1 — 디지털 명판') },
    { file: 'IDTA-02035-2_BatteryPassport_HandoverDocumentation_1.1.aasx', spec: 'IDTA 02035-2', version: '1.1', label: tr('배터리 여권 2 — 인도 문서') },
    { file: 'IDTA-02035-3_BatteryPassport_ProductCarbonFootprint_1.1.aasx', spec: 'IDTA 02035-3', version: '1.1', label: tr('배터리 여권 3 — 제품 탄소 발자국') },
    { file: 'IDTA-02035-4_BatteryPassport_TechnicalData_1.0.2.aasx', spec: 'IDTA 02035-4', version: '1.0.2', label: tr('배터리 여권 4 — 기술 데이터') },
    { file: 'IDTA-02035-5_BatteryPassport_ProductCondition_1.0.2.aasx', spec: 'IDTA 02035-5', version: '1.0.2', label: tr('배터리 여권 5 — 제품 상태') },
    { file: 'IDTA-02035-6_BatteryPassport_MaterialComposition_1.0.2.aasx', spec: 'IDTA 02035-6', version: '1.0.2', label: tr('배터리 여권 6 — 소재 구성') },
    { file: 'IDTA-02035-7_BatteryPassport_Circularity_1.0.2.aasx', spec: 'IDTA 02035-7', version: '1.0.2', label: tr('배터리 여권 7 — 순환성') },
  ];
}

/** Fetch one shipped template as a File, ready for the normal upload path */
export async function fetchDppTemplate(file: string): Promise<File> {
  const response = await fetch(`${import.meta.env.BASE_URL}samples/idta/${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(fill(tr('견본 파일을 받지 못했습니다 ({0}).'), { 0: response.status }));
  return new File([await response.blob()], file, { type: 'application/asset-administration-shell-package' });
}
