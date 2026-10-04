/**
 * L1 — 직렬화 · 패키징 규칙.
 *
 * 여기서 걸리는 결함은 증상이 엉뚱한 곳에 나타난다.
 * File.value가 단순 상대경로면 공식 스키마의 ArrayItemNotValid가 되어
 * 상위 SMC와 Submodel까지 연쇄 실패로 표시된다 — 대량 오류의 실제 원인이 여기인 경우가 많다.
 */
import type { File as AasFile, LangString, MultiLanguageProperty } from '@aas/core';
import type { Rule } from '../types.js';
import { duplicateLanguages, iec61360Of } from '../util.js';

const SOURCE = '04_린터_규칙_명세.md §1 L1';

export const pkgFileUri: Rule = {
  id: 'PKG-FILE-URI',
  layer: 'L1',
  title: 'File.value는 file:// URI 형식이어야 한다',
  source: SOURCE,
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'File') continue;
      const file = v.node as AasFile;
      const value = file.value;
      if (value === undefined || value === '') continue; // 값 없음은 별도 문제

      // file:// 또는 http(s):// 등 스킴이 있으면 통과
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) continue;

      report({
        severity: 'error',
        elementType: 'File',
        key: file.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/value`,
        kosmoPath: v.kosmoPath,
        message: `File.value가 URI 형식이 아닙니다: ${value}`,
        remedy:
          'file:///파일명 형태로 바꾸십시오. 단순 상대경로는 공식 스키마 위반이며, ' +
          'ArrayItemNotValid로 상위 SMC·Submodel까지 연쇄 실패 표시를 유발합니다.',
        fixable: true,
      });
    }
  },
};

export const pkgThumbnailParts: Rule = {
  id: 'PKG-THUMB-PART',
  layer: 'L1',
  title: '썸네일은 파트 · 관계 · Content_Types 세 곳에 모두 있어야 한다',
  source: SOURCE,
  check(ctx, report) {
    const pkg = ctx.package;
    if (!pkg) return; // Environment만 린트하는 경우 건너뛴다

    const shell = ctx.environment.assetAdministrationShells?.[0];
    const key = shell?.idShort ?? shell?.id ?? 'AASX';
    const thumbPath = shell?.assetInformation?.defaultThumbnail?.path;
    if (!thumbPath) return; // KOSMO-AAS-1이 보고한다

    const normalized = thumbPath.startsWith('/') ? thumbPath : `/${thumbPath}`;
    const missing: string[] = [];
    if (!pkg.parts.includes(normalized)) missing.push('ZIP 파트');
    if (!pkg.relationshipTargets.includes(normalized)) missing.push('_rels 관계 선언');
    // 🔴 Override가 없어도 확장자 Default(`<Default Extension="png">`)가 덮으면 OPC 규격상 유효하다.
    //    Validator가 실제로 떨어뜨린 사유는 defaultThumbnail이 빈 것(02 §2-①)이었지 Default 선언이
    //    아니었다. 사업 참조모델 v0.0.1 30종이 전부 이 형태라 위반으로 두면 화면이 온통 빨갛다
    //    (2026-09-30 실측). Validator 실측 전까지는 **참고**로 알린다
    const overridden = pkg.contentTypeOverrides.includes(normalized);
    const extension = normalized.slice(normalized.lastIndexOf('.') + 1).toLowerCase();
    const byDefault = !overridden && (pkg.contentTypeDefaults ?? []).includes(extension);
    if (!overridden && !byDefault) missing.push('Content_Types Override');

    if (missing.length === 0 && byDefault) {
      report({
        severity: 'info',
        elementType: 'AssetAdministrationShell',
        key,
        pointer: '/assetAdministrationShells/0/assetInformation/defaultThumbnail',
        kosmoPath: `/assetAdministrationShells/0(${key})/assetInformation/defaultThumbnail`,
        message: `썸네일 ${normalized}의 형식이 파일별(Override)이 아니라 확장자 기본값(Default .${extension})으로 선언돼 있습니다.`,
        remedy:
          'OPC 규격상 유효한 선언입니다. 이 도구로 저장하면 파일별 선언이 함께 들어갑니다(writeAasx). Validator가 이 형태를 떨어뜨린 실측은 아직 없습니다.',
        fixable: false,
      });
      return;
    }

    if (missing.length > 0) {
      report({
        severity: 'error',
        elementType: 'AssetAdministrationShell',
        key,
        pointer: '/assetAdministrationShells/0/assetInformation/defaultThumbnail',
        kosmoPath: `/assetAdministrationShells/0(${key})/assetInformation/defaultThumbnail`,
        message: `썸네일 ${normalized}에 대해 누락된 항목이 있습니다: ${missing.join(', ')}`,
        remedy: '세 곳이 모두 있어야 Validator를 통과합니다. 하나라도 빠지면 열리기는 하나 검증에서 떨어집니다.',
        fixable: true,
      });
    }
  },
};

export const pkgLanguageDuplicate: Rule = {
  id: 'PKG-LANG-DUP',
  layer: 'L1',
  title: '같은 LangString 안에 동일 언어 태그가 중복될 수 없다',
  source: `${SOURCE} (IDTA 원본 CD의 en 태그 오타가 따라오는 사례)`,
  check(ctx, report) {
    const relaxed = ctx.policy.langTagTypo === 'preserve';
    const severity = relaxed ? 'warning' : 'error';

    const check = (
      strings: LangString[] | undefined,
      field: string,
      elementType: string,
      key: string,
      pointer: string,
      kosmoPath: string,
    ): void => {
      const dup = duplicateLanguages(strings);
      if (dup.length === 0) return;
      report({
        severity,
        elementType,
        key,
        pointer: `${pointer}/${field}`,
        kosmoPath,
        message: `${field}에 동일한 언어 태그가 중복됩니다: ${dup.join(', ')}`,
        remedy:
          '텍스트는 손대지 말고, 같은 항목의 다른 필드에서 근거가 확인될 때만 언어 태그를 교정하십시오. ' +
          '근거가 없으면 중복 항목만 제거하십시오.',
        fixable: true,
        policyNote: relaxed
          ? 'KTL §7(템플릿 원본 유지)을 따르는 정책(preserve)이라 경고로만 표시했습니다.'
          : undefined,
      });
    };

    // ConceptDescription의 IEC 61360 다국어 필드
    (ctx.environment.conceptDescriptions ?? []).forEach((cd, i) => {
      const key = cd.idShort ?? cd.id;
      const base = `/conceptDescriptions/${i}`;
      const kosmo = `/conceptDescriptions/${i}(${key})`;
      const content = iec61360Of(cd);
      if (content) {
        const contentBase = `${base}/embeddedDataSpecifications/0/dataSpecificationContent`;
        check(content.preferredName, 'preferredName', 'ConceptDescription', key, contentBase, kosmo);
        check(content.shortName, 'shortName', 'ConceptDescription', key, contentBase, kosmo);
        check(content.definition, 'definition', 'ConceptDescription', key, contentBase, kosmo);
      }
      check(cd.description, 'description', 'ConceptDescription', key, base, kosmo);
      check(cd.displayName, 'displayName', 'ConceptDescription', key, base, kosmo);
    });

    // Submodel · SubmodelElement의 다국어 필드
    (ctx.environment.submodels ?? []).forEach((sm, i) => {
      const key = sm.idShort ?? sm.id;
      check(sm.description, 'description', 'Submodel', key, `/submodels/${i}`, `/submodels/${i}(${key})`);
      check(sm.displayName, 'displayName', 'Submodel', key, `/submodels/${i}`, `/submodels/${i}(${key})`);
    });

    for (const v of ctx.elements) {
      const key = v.node.idShort ?? v.idShortPath;
      check(v.node.description, 'description', v.node.modelType, key, v.pointer, v.kosmoPath);
      check(v.node.displayName, 'displayName', v.node.modelType, key, v.pointer, v.kosmoPath);
      if (v.node.modelType === 'MultiLanguageProperty') {
        check((v.node as MultiLanguageProperty).value, 'value', v.node.modelType, key, v.pointer, v.kosmoPath);
      }
    }
  },
};

/**
 * 빈 배열 금지.
 *
 * 🔴 V3.0 공식 스키마는 배열마다 `minItems: 1`을 건다 — **비었으면 키가 아예 없어야 한다.**
 * KOSMO Validator는 이걸 보지 않아서, `aas-test-engines`를 돌려 보고서야 드러났다
 * ("Empty array not allowed", 1.0.3 실측). 요소를 전부 지운 서브모델이 이 상태가 되기 쉽다.
 *
 * 빼는 것 말고 다른 해석이 없어서 **자동 교정 대상**이다(AASd-120과 달리 의미가 바뀌지 않는다).
 */
export const pkgEmptyArray: Rule = {
  id: 'PKG-EMPTY-ARRAY',
  layer: 'L1',
  title: '빈 배열을 남기지 않는다 (공식 스키마 minItems: 1)',
  source: 'IDTA 01001-3-0 JSON Schema',
  check(ctx, report) {
    const walk = (value: unknown, pointer: string, owner: string): void => {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          report({
            severity: 'error',
            elementType: owner,
            key: pointer.slice(pointer.lastIndexOf('/') + 1),
            pointer,
            kosmoPath: pointer,
            message: `빈 배열이 남아 있습니다: ${pointer}`,
            remedy:
              '항목을 넣거나 키를 지우십시오. 공식 스키마는 빈 배열을 허용하지 않습니다 ' +
              '(KOSMO Validator는 검사하지 않지만 aas-test-engines가 오류로 떨어뜨립니다).',
            fixable: true,
          });
          return;
        }
        value.forEach((item, index) => walk(item, `${pointer}/${index}`, owner));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      const nextOwner = typeof record['modelType'] === 'string' ? String(record['modelType']) : owner;
      for (const [key, child] of Object.entries(record)) {
        walk(child, `${pointer}/${key}`, nextOwner);
      }
    };

    walk(ctx.environment as unknown, '', 'Environment');
  },
};

export const L1_RULES: readonly Rule[] = [
  pkgFileUri,
  pkgThumbnailParts,
  pkgLanguageDuplicate,
  pkgEmptyArray,
];
