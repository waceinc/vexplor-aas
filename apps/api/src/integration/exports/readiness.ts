/**
 * Integration readiness checks INT-1…INT-5 (design §8, D9).
 *
 * Why not lint rules: the lint catalogue is the KOSMO submission contract and its rule list is CI-checked; these checks
 * concern a different audience (ERP / MES / CMMS integrators). They are reported by `GET /integrations/readiness`
 * and **enforced by the exports** (Type excluded, BOM refused, interval reported missing, ×n never expanded).
 */
import { fill, tr, type Environment } from '@aas/core';
import { readBom } from './bom.js';
import { assetInformationOf, shellsOf } from './elements.js';
import { isProcessFile, nodeKey, readHierarchy } from './location.js';
import { explicitInterval, maintenanceSubmodel, planElements } from './maintenance.js';
import { nameplateSubmodels, serialNumberOf } from './nameplate.js';

export type ReadinessId = 'INT-1' | 'INT-2' | 'INT-3' | 'INT-4' | 'INT-5';

export interface ReadinessCheck {
  id: ReadinessId;
  severity: 'warning' | 'error';
  message: string;
  /** Where to look — `Submodel/idShortPath` or a hierarchy node path */
  pointer?: string;
}

/** Fixed text of a check — shared with the exports that enforce it */
export function readinessMessage(id: ReadinessId): string {
  switch (id) {
    case 'INT-1':
      return tr('INT-1: 형식(Type) 셸에 제조번호(SerialNumber)가 있습니다 — 설비 대장으로 내보내기 전에 실물 단위 파일로 나누십시오.');
    case 'INT-2':
      return tr('INT-2: BOM 진입 노드의 globalAssetId가 셸의 globalAssetId와 다릅니다.');
    case 'INT-3':
      return tr('INT-3: 정비 계획에 명시적인 주기 값과 단위가 없습니다.');
    case 'INT-4':
      return tr('INT-4: 수량이 1보다 큰 계층 노드가 globalAssetId 하나를 가리킵니다 — 설비 행으로 늘리지 않습니다.');
    case 'INT-5':
      return tr('INT-5: Instance 셸에 제조번호(SerialNumber)가 없습니다.');
  }
}

export function bomRootMismatchMessage(entry: string | null, shell: string): string {
  return fill(tr('BOM 진입 노드의 globalAssetId({0})가 셸의 globalAssetId({1})와 다릅니다.'), { 0: entry ?? '-', 1: shell });
}

export function readinessChecks(environment: Environment): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const shell = shellsOf(environment)[0];
  const assetKind = assetInformationOf(shell)['assetKind'];
  const plate = nameplateSubmodels(environment, shell).nameplate;
  const serialPointer = `${String(plate?.['idShort'] ?? 'DigitalNameplate')}/SerialNumber`;
  const serial = shell ? serialNumberOf(environment, shell) : null;

  if (assetKind === 'Type' && serial !== null) {
    checks.push({ id: 'INT-1', severity: 'warning', message: readinessMessage('INT-1'), pointer: serialPointer });
  }
  if (assetKind === 'Instance' && plate && serial === null) {
    checks.push({ id: 'INT-5', severity: 'warning', message: readinessMessage('INT-5'), pointer: serialPointer });
  }

  const processFile = isProcessFile(environment);
  if (!processFile) {
    const bom = readBom(environment, undefined);
    if (!bom.ok && bom.reason === 'root-mismatch') {
      checks.push({
        id: 'INT-2',
        severity: 'error',
        message: `INT-2: ${bomRootMismatchMessage(bom.entryGlobalAssetId, bom.shellGlobalAssetId)}`,
        pointer: 'HierarchicalStructures',
      });
    }
  }

  const maintenance = maintenanceSubmodel(environment);
  for (const plan of maintenance ? planElements(maintenance) : []) {
    if (explicitInterval(environment, plan) === null) {
      checks.push({ id: 'INT-3', severity: 'warning', message: readinessMessage('INT-3'), pointer: `${String(maintenance?.['idShort'])}/${plan.path}` });
    }
  }

  // ×n on equipment inside a process file — in an equipment BOM a quantity is normal and not a finding
  if (processFile) {
    for (const node of readHierarchy(environment)?.nodes ?? []) {
      if (node.depth > 0 && node.globalAssetId && node.bulkCount > 1) {
        checks.push({ id: 'INT-4', severity: 'warning', message: readinessMessage('INT-4'), pointer: nodeKey(node) });
      }
    }
  }
  return checks;
}
