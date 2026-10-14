/**
 * Frozen CSV columns of the integration exports (design §4.4, ERP E-2).
 *
 * Important: these lists are the contract with ERP / CMMS upload templates. Columns may only be **appended**; renaming,
 *    reordering or removing one means a new schema version (`/2`) and a new constant next to the old one.
 *    A test compares each list with a frozen copy, so an accidental edit fails the build.
 * Human labels (`headers=ko`) may change between versions — the keys may not.
 */
import { tr } from '@aas/core';

export const EQUIPMENT_SCHEMA = 'vexplor.equipmentMaster/1';
export const BOM_SCHEMA = 'vexplor.bom/1';
export const HIERARCHY_SCHEMA = 'kr.vexplor.aas.hierarchy.v1';
export const MAINTENANCE_SCHEMA = 'vexplor.maintenancePlan/1';
export const DOCUMENTS_SCHEMA = 'vexplor.documents/1';

export const EQUIPMENT_V1_COLUMNS = [
  'key', 'aasId', 'assetKind', 'typeAasId', 'packageId', 'revision',
  'nameplate.manufacturer', 'nameplate.productDesignation', 'nameplate.productFamily', 'nameplate.modelNumber',
  'nameplate.orderCode', 'nameplate.serialNumber', 'nameplate.yearOfConstruction', 'nameplate.dateOfManufacture',
  'nameplate.productUri', 'nameplate.markings',
  'physical.weight.value', 'physical.weight.unit',
  'location.path', 'location.isa95.site', 'location.isa95.area', 'location.isa95.workCenter',
  'specificAssetIds', 'externalRefs', 'missing', 'warnings',
] as const;

export const BOM_V1_COLUMNS = [
  'rootKey', 'parentPath', 'childPath', 'childName', 'childGlobalAssetId', 'quantity', 'level', 'entityType', 'erpMaterial', 'mapped',
] as const;

export const HIERARCHY_V1_COLUMNS = [
  'id', 'parentId', 'equipmentLevel', 'name', 'globalAssetId', 'aasId', 'packageId', 'serialNumber', 'quantity', 'specificAssetIds', 'warnings',
] as const;

export const MAINTENANCE_V1_COLUMNS = [
  'maintenanceId', 'taskName', 'interval', 'intervalStatus', 'technicians', 'qualification', 'safety',
  'stepSeq', 'stepId', 'stepName', 'instruction', 'durationValue', 'durationUnit', 'toolIds', 'consumableIds', 'documents',
  'signatureRequired', 'sourceRef',
] as const;

export const DOCUMENTS_V1_COLUMNS = [
  'documentId', 'documentDomainId', 'classId', 'className', 'classificationSystem', 'version', 'language', 'title',
  'status', 'statusDate', 'issuer', 'fileName', 'contentType', 'size', 'sha256', 'available', 'url',
] as const;

/** Human column labels in the request language (`headers=ko`). Unknown keys fall back to the key itself */
const LABELS: Record<string, () => string> = {
  key: () => tr('설비 키(globalAssetId)'),
  aasId: () => 'AAS ID',
  assetKind: () => tr('자산 종류'),
  typeAasId: () => tr('형식 AAS ID'),
  packageId: () => tr('패키지 ID'),
  revision: () => tr('리비전'),
  'nameplate.manufacturer': () => tr('제조사'),
  'nameplate.productDesignation': () => tr('설비명'),
  'nameplate.productFamily': () => tr('제품군'),
  'nameplate.modelNumber': () => tr('모델명'),
  'nameplate.orderCode': () => tr('제조사 품번'),
  'nameplate.serialNumber': () => tr('제조번호'),
  'nameplate.yearOfConstruction': () => tr('제조년도'),
  'nameplate.dateOfManufacture': () => tr('제조일자'),
  'nameplate.productUri': () => tr('제품 URI'),
  'nameplate.markings': () => tr('인증 표시'),
  'physical.weight.value': () => tr('중량'),
  'physical.weight.unit': () => tr('중량 단위'),
  'location.path': () => tr('위치 경로'),
  'location.isa95.site': () => tr('사업장'),
  'location.isa95.area': () => tr('라인'),
  'location.isa95.workCenter': () => tr('공정'),
  specificAssetIds: () => tr('자산 식별자'),
  externalRefs: () => tr('외부 참조'),
  missing: () => tr('빠진 항목'),
  warnings: () => tr('경고'),
  rootKey: () => tr('상위 설비 키'),
  parentPath: () => tr('상위 경로'),
  childPath: () => tr('하위 경로'),
  childName: () => tr('하위 이름'),
  childGlobalAssetId: () => tr('하위 globalAssetId'),
  quantity: () => tr('수량'),
  level: () => tr('단계'),
  entityType: () => tr('엔티티 종류'),
  erpMaterial: () => tr('ERP 품목'),
  mapped: () => tr('품목 연결됨'),
  id: () => tr('노드 ID'),
  parentId: () => tr('상위 노드 ID'),
  equipmentLevel: () => tr('ISA-95 수준'),
  name: () => tr('이름'),
  globalAssetId: () => 'globalAssetId',
  serialNumber: () => tr('제조번호'),
  maintenanceId: () => tr('정비 ID'),
  taskName: () => tr('정비 작업명'),
  interval: () => tr('주기'),
  intervalStatus: () => tr('주기 상태'),
  technicians: () => tr('필요 인원'),
  qualification: () => tr('필요 자격'),
  safety: () => tr('안전 규정'),
  stepSeq: () => tr('단계 순번'),
  stepId: () => tr('단계 ID'),
  stepName: () => tr('단계명'),
  instruction: () => tr('작업 지시'),
  durationValue: () => tr('예상 소요'),
  durationUnit: () => tr('소요 단위'),
  toolIds: () => tr('공구 ID'),
  consumableIds: () => tr('소모품 ID'),
  documents: () => tr('관련 문서'),
  signatureRequired: () => tr('서명 필요'),
  sourceRef: () => tr('원본 위치'),
  documentId: () => tr('문서 ID'),
  documentDomainId: () => tr('문서 도메인 ID'),
  classId: () => tr('분류 ID'),
  className: () => tr('분류명'),
  classificationSystem: () => tr('분류 체계'),
  version: () => tr('버전'),
  language: () => tr('언어'),
  title: () => tr('제목'),
  status: () => tr('상태'),
  statusDate: () => tr('상태 일자'),
  issuer: () => tr('발행처'),
  fileName: () => tr('파일 이름'),
  contentType: () => tr('콘텐츠 형식'),
  size: () => tr('크기(바이트)'),
  sha256: () => 'SHA-256',
  available: () => tr('파일 있음'),
  url: () => tr('내려받기 주소'),
};

export function columnLabel(key: string): string {
  return LABELS[key]?.() ?? key;
}
