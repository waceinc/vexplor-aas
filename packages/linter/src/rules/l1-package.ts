/**
 * L1 - serialization and packaging rules.
 *
 * Defects caught here show symptoms in unexpected places.
 * If File.value is a bare relative path, it becomes ArrayItemNotValid in the official schema,
 * and the parent SMC and Submodel are shown as cascading failures - the real cause of mass errors is often here.
 */
import type { File as AasFile, LangString, MultiLanguageProperty } from '@aas/core';
import { fill, tr } from '@aas/core';
import type { Rule } from '../types.js';
import { duplicateLanguages, iec61360Of } from '../util.js';

// i18n-ignore — source document file name
const SOURCE = '04_린터_규칙_명세.md §1 L1';

export const pkgFileUri: Rule = {
  id: 'PKG-FILE-URI',
  layer: 'L1',
  get title() {
    return tr('File.value는 file:// URI 형식이어야 한다');
  },
  source: SOURCE,
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'File') continue;
      const file = v.node as AasFile;
      const value = file.value;
      if (value === undefined || value === '') continue; // A missing value is a separate issue

      // Passes if there is a scheme such as file:// or http(s)://
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) continue;

      report({
        severity: 'error',
        elementType: 'File',
        key: file.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/value`,
        kosmoPath: v.kosmoPath,
        message: fill(tr('File.value가 URI 형식이 아닙니다: {0}'), { 0: value }),
        remedy: tr(
          'file:///파일명 형태로 바꾸십시오. 단순 상대경로는 공식 스키마 위반이며, ArrayItemNotValid로 상위 SMC·Submodel까지 연쇄 실패 표시를 유발합니다.',
        ),
        fixable: true,
      });
    }
  },
};

export const pkgThumbnailParts: Rule = {
  id: 'PKG-THUMB-PART',
  layer: 'L1',
  get title() {
    return tr('썸네일은 파트 · 관계 · Content_Types 세 곳에 모두 있어야 한다');
  },
  source: SOURCE,
  check(ctx, report) {
    const pkg = ctx.package;
    if (!pkg) return; // Skip when linting only an Environment

    const shell = ctx.environment.assetAdministrationShells?.[0];
    const key = shell?.idShort ?? shell?.id ?? 'AASX';
    const thumbPath = shell?.assetInformation?.defaultThumbnail?.path;
    if (!thumbPath) return; // Reported by KOSMO-AAS-1

    const normalized = thumbPath.startsWith('/') ? thumbPath : `/${thumbPath}`;
    const missing: string[] = [];
    if (!pkg.parts.includes(normalized)) missing.push(tr('ZIP 파트'));
    if (!pkg.relationshipTargets.includes(normalized)) missing.push(tr('_rels 관계 선언'));
    // Important: even without an Override, an extension Default (`<Default Extension="png">`) covering it is valid per OPC.
    //    The actual reason the Validator failed it was an empty defaultThumbnail (02 §2-①), not the Default
    //    declaration. All 30 project reference models v0.0.1 have this form, so treating it as a violation turns the screen red
    //    (measured 2026-09-30). Until verified against the Validator, it is reported as **informational**
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
        message: fill(
          tr('썸네일 {0}의 형식이 파일별(Override)이 아니라 확장자 기본값(Default .{1})으로 선언돼 있습니다.'),
          { 0: normalized, 1: extension },
        ),
        remedy: tr(
          'OPC 규격상 유효한 선언입니다. 이 도구로 저장하면 파일별 선언이 함께 들어갑니다(writeAasx). Validator가 이 형태를 떨어뜨린 실측은 아직 없습니다.',
        ),
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
        message: fill(tr('썸네일 {0}에서 빠진 항목이 있습니다: {1}'), { 0: normalized, 1: missing.join(', ') }),
        remedy: tr('세 곳이 모두 있어야 Validator를 통과합니다. 하나라도 빠지면 열리기는 하나 검증에서 떨어집니다.'),
        fixable: true,
      });
    }
  },
};

export const pkgLanguageDuplicate: Rule = {
  id: 'PKG-LANG-DUP',
  layer: 'L1',
  get title() {
    return tr('같은 LangString 안에 동일 언어 태그가 중복될 수 없다');
  },
  get source() {
    return fill(tr('{0} (IDTA 원본 CD의 en 태그 오타가 따라오는 사례)'), { 0: SOURCE });
  },
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
        message: fill(tr('{0}에 동일한 언어 태그가 중복됩니다: {1}'), { 0: field, 1: dup.join(', ') }),
        remedy: tr(
          '텍스트는 손대지 말고, 같은 항목의 다른 필드에서 근거가 확인될 때만 언어 태그를 교정하십시오. 근거가 없으면 중복 항목만 제거하십시오.',
        ),
        fixable: true,
        policyNote: relaxed
          ? tr('KTL §7(템플릿 원본 유지)을 따르는 정책(preserve)이라 경고로만 표시했습니다.')
          : undefined,
      });
    };

    // Multilingual fields of the IEC 61360 data specification in ConceptDescription
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

    // Multilingual fields of Submodel and SubmodelElement
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
 * No empty arrays.
 *
 * Important: the official V3.0 schema sets `minItems: 1` on every array - **if empty, the key must be absent entirely.**
 * The KOSMO Validator does not check this; it only surfaced after running `aas-test-engines`
 * ("Empty array not allowed", measured with 1.0.3). A submodel with all elements deleted easily ends up in this state.
 *
 * Removing it is the only possible interpretation, so it is **auto-fixable** (unlike AASd-120, the meaning does not change).
 */
export const pkgEmptyArray: Rule = {
  id: 'PKG-EMPTY-ARRAY',
  layer: 'L1',
  get title() {
    return tr('빈 배열을 남기지 않는다 (공식 스키마 minItems: 1)');
  },
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
            message: fill(tr('빈 배열이 남아 있습니다: {0}'), { 0: pointer }),
            remedy: tr(
              '항목을 넣거나 키를 지우십시오. 공식 스키마는 빈 배열을 허용하지 않습니다 (KOSMO Validator는 검사하지 않지만 aas-test-engines가 오류로 떨어뜨립니다).',
            ),
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
