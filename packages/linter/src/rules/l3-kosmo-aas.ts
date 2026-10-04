/**
 * L3 — KOSMO 사업 규칙 · AAS #1 ~ #6.
 *
 * 근거: docs/rules/02_Validator_대응규칙.md §1.2 / §2, 04_린터_규칙_명세.md §1.
 * 실측 결함 이력: #1(1차 위반) · #3(1·2차 위반).
 */
import type { AssetAdministrationShell } from '@aas/core';
import type { LintContext, Rule } from '../types.js';
import { isOrganizationalAssetType } from '../scaffold.js';
import { idVersionSuffix, isValidIdShort } from '../util.js';

const SOURCE = '02_Validator_대응규칙.md §1.2 · §2';

/** AAS 하나를 순회하며 위치 정보를 만들어 준다 */
function eachShell(
  ctx: LintContext,
  fn: (shell: AssetAdministrationShell, pointer: string, kosmoPath: string) => void,
): void {
  (ctx.environment.assetAdministrationShells ?? []).forEach((shell, i) => {
    fn(
      shell,
      `/assetAdministrationShells/${i}`,
      `/assetAdministrationShells/${i}(${shell.idShort ?? shell.id})`,
    );
  });
}

export const kosmoAas1Thumbnail: Rule = {
  id: 'KOSMO-AAS-1',
  layer: 'L3',
  title: 'Thumbnail 이미지 검사 — defaultThumbnail 설정 및 패키지 파트 일치',
  source: SOURCE,
  check(ctx, report) {
    eachShell(ctx, (shell, pointer, kosmoPath) => {
      const key = shell.idShort ?? shell.id;
      const thumb = shell.assetInformation?.defaultThumbnail;

      if (!thumb || !thumb.path) {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key,
          pointer: `${pointer}/assetInformation/defaultThumbnail`,
          kosmoPath: `${kosmoPath}/assetInformation/defaultThumbnail`,
          message: 'AssetInformation에 defaultThumbnail이 설정되어 있지 않습니다.',
          remedy:
            '패키지의 썸네일 파트와 같은 경로로 defaultThumbnail을 지정하십시오. ' +
            '예: path=/thumbnail.png, contentType=image/png',
          fixable: true,
        });
        return;
      }

      // 패키지 정보가 있을 때만 파트 실재 여부를 본다
      const pkg = ctx.package;
      if (!pkg) return;

      const normalized = thumb.path.startsWith('/') ? thumb.path : `/${thumb.path}`;
      if (!pkg.parts.includes(normalized)) {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key,
          pointer: `${pointer}/assetInformation/defaultThumbnail/path`,
          kosmoPath: `${kosmoPath}/assetInformation/defaultThumbnail/path`,
          message: `defaultThumbnail이 가리키는 파트가 패키지에 없습니다: ${thumb.path}`,
          remedy:
            '썸네일 파일을 패키지에 넣고 _rels/.rels 관계와 Content_Types Override를 함께 추가하십시오.',
          fixable: true,
        });
      }
    });
  },
};

export const kosmoAas2IdShort: Rule = {
  id: 'KOSMO-AAS-2',
  layer: 'L3',
  title: 'AAS idShort 설정 및 명명 규칙 검사',
  source: SOURCE,
  check(ctx, report) {
    eachShell(ctx, (shell, pointer, kosmoPath) => {
      const key = shell.idShort ?? shell.id;
      if (!shell.idShort) {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: 'AAS에 idShort가 없습니다.',
          remedy: '장비 영문명을 CamelCase로 지정하십시오.',
          fixable: false,
        });
        return;
      }
      if (!isValidIdShort(shell.idShort)) {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: `idShort가 명명 규칙에 맞지 않습니다: ${shell.idShort}`,
          remedy:
            '영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오. 한글·공백·특수문자는 쓸 수 없고 하이픈으로 끝날 수 없습니다.',
          fixable: true,
        });
      }
    });
  },
};

export const kosmoAas3IdFormat: Rule = {
  id: 'KOSMO-AAS-3',
  layer: 'L3',
  title: 'AAS Id 형식 검사 — administration의 version·revision과 Id 접미 일치',
  source: `${SOURCE} (실측 1·2차 위반)`,
  check(ctx, report) {
    eachShell(ctx, (shell, pointer, kosmoPath) => {
      const key = shell.idShort ?? shell.id;
      const admin = shell.administration;
      if (!admin?.version || !admin.revision) {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key,
          pointer: `${pointer}/administration`,
          kosmoPath: `${kosmoPath}/administration`,
          message: 'Version 정보가 부족하여 Id 형식을 검증할 수 없습니다.',
          remedy: 'administration에 version과 revision을 모두 입력하십시오.',
          fixable: true,
        });
        return;
      }
      const expected = `${admin.version}/${admin.revision}`;
      const actual = idVersionSuffix(shell.id);
      if (actual !== expected) {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key,
          pointer: `${pointer}/id`,
          kosmoPath: `${kosmoPath}/id`,
          message: `Id의 끝 두 세그먼트가 administration과 일치하지 않습니다: ${actual} (기대값 ${expected})`,
          remedy: `Id가 ${expected} 로 끝나도록 맞추십시오.`,
          fixable: true,
        });
      }
    });
  },
};

export const kosmoAas4RequiredSubmodels: Rule = {
  id: 'KOSMO-AAS-4',
  layer: 'L3',
  title: '필수 Submodel 포함 여부 검사 — DN·HD·TD·OD 4종 + 총 6~8종',
  source: `${SOURCE} §1.3-2`,
  check(ctx, report) {
    const submodels = ctx.environment.submodels ?? [];
    const present = new Set(submodels.map((s) => s.idShort ?? ''));
    const [min, max] = ctx.policy.submodelCountRange;
    const shell = ctx.environment.assetAdministrationShells?.[0];
    const key = shell?.idShort ?? shell?.id ?? 'AAS 없음';

    // 🔴 공정·회사 파일(assetType 표시)에는 이 규칙을 적용하지 않는다. 필수 4종(명판·기술사양…)과
    //    6~8종 하한은 **설비 20종 실측**에서 나온 설비 규칙이고, 조직 단위는 Validator 제출용이
    //    아니라 실공정 구성을 담는 파일이다(2026-08-26 사용자 확정).
    if (isOrganizationalAssetType(shell?.assetInformation?.assetType, ctx.policy.iriBase)) return;

    const missing = ctx.policy.requiredSubmodels.filter((r) => !present.has(r));
    if (missing.length > 0) {
      report({
        severity: 'error',
        elementType: 'AssetAdministrationShell',
        key,
        pointer: '/submodels',
        kosmoPath: '/submodels',
        message: `필수 Submodel이 없습니다: ${missing.join(', ')}`,
        remedy: '누락된 서브모델을 IDTA 표준 템플릿으로 추가하십시오.',
        fixable: false,
      });
    }

    if (submodels.length < min || submodels.length > max) {
      report({
        severity: 'error',
        elementType: 'AssetAdministrationShell',
        key,
        pointer: '/submodels',
        kosmoPath: '/submodels',
        message: `Submodel 개수가 허용 범위를 벗어났습니다: ${submodels.length}종 (허용 ${min}~${max}종)`,
        remedy:
          submodels.length > max
            ? `서브모델을 ${max}종 이하로 통합하십시오. ${max + 1}종 이상은 그 자체로 위반입니다.`
            : `서브모델을 ${min}종 이상으로 보강하십시오.`,
        fixable: false,
      });
    }
  },
};

export const kosmoAas5GlobalAssetId: Rule = {
  id: 'KOSMO-AAS-5',
  layer: 'L3',
  title: 'globalAssetId 검사',
  source: SOURCE,
  check(ctx, report) {
    eachShell(ctx, (shell, pointer, kosmoPath) => {
      const ai = shell.assetInformation;
      const hasSpecific = (ai?.specificAssetIds?.length ?? 0) > 0;
      if (!ai?.globalAssetId && !hasSpecific) {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key: shell.idShort ?? shell.id,
          pointer: `${pointer}/assetInformation/globalAssetId`,
          kosmoPath: `${kosmoPath}/assetInformation/globalAssetId`,
          message: 'globalAssetId가 없습니다.',
          remedy: `${ctx.policy.iriBase}/asset/{장비명}/{version}/{revision} 형식으로 지정하십시오.`,
          fixable: true,
        });
      }
    });
  },
};

export const kosmoAas6TypeKind: Rule = {
  id: 'KOSMO-AAS-6',
  layer: 'L3',
  title: 'Type 유형 검사 — assetKind는 Type이어야 한다',
  source: SOURCE,
  check(ctx, report) {
    eachShell(ctx, (shell, pointer, kosmoPath) => {
      const kind = shell.assetInformation?.assetKind;
      if (kind !== 'Type') {
        report({
          severity: 'error',
          elementType: 'AssetAdministrationShell',
          key: shell.idShort ?? shell.id,
          pointer: `${pointer}/assetInformation/assetKind`,
          kosmoPath: `${kosmoPath}/assetInformation/assetKind`,
          message: `assetKind가 Type이 아닙니다: ${kind ?? '없음'}`,
          remedy: 'assetKind를 Type으로 지정하십시오. 본 사업 산출물은 형식(Type) 단위입니다.',
          fixable: true,
        });
      }
    });
  },
};

export const KOSMO_AAS_RULES: readonly Rule[] = [
  kosmoAas1Thumbnail,
  kosmoAas2IdShort,
  kosmoAas3IdFormat,
  kosmoAas4RequiredSubmodels,
  kosmoAas5GlobalAssetId,
  kosmoAas6TypeKind,
];
