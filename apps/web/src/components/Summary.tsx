/**
 * 파일 요약 — 요소를 고르기 전에 가운데 칸이 놀지 않게 한다.
 *
 * 파일을 열자마자 알아야 하는 것은 둘이다: **무엇이 들었나 · 통과인가.**
 * 화면으로 보고서야 이 자리가 통째로 비어 있다는 걸 알았다(2026-08-24).
 * 「다음 할 일」 목록은 2026-09-08에 뺐다 — 사용자: "당연한 거라 삭제해도 될 것 같아". 빈 서브모델 안내만 판정 줄에 남겼다.
 */
import { countElements } from '../model.js';
import { fill } from '../i18n.js';
import type { ConceptDescription, Finding, Shell, Submodel } from '../model.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  fileName: string;
  /**
   * 묶음 파일의 구성 집계 — 있으면 원시 숫자(요소 n) 대신 이걸 보여 준다.
   * 🔴 묶음에서 「요소 8」은 공정 마디·연결선(HasPart)·설정값까지 합친 수라
   *    사람이 보는 구성(공정 2·설비 3)과 어긋난다(2026-08-26 사용자 제보).
   */
  composition?: { groups: number; assets: number; units: number };
  /**
   * 담긴 내용 합계 — ⚙로 이어진 설비 파일들까지 합친 서브모델·요소·CD 총량.
   * 🔴 자체 파일의 원시 숫자를 다시 보여 주는 게 아니다(그건 혼란으로 판명 —
   *    요소 8이 공정 마디·연결선 합계였다). 트리에 보이는 전체의 합이라야 의미가 있다.
   */
  totals?: { submodels: number; elements: number; concepts: number; unopened: number };
  /** 대표 사진이 아직 임시 그림인가 — 「다음 할 일」이 없어진 뒤(2026-09-08) 쓰지 않는다. 호출부 호환용 */
  thumbnailPlaceholder?: boolean;
  shells: readonly Shell[];
  submodels: readonly Submodel[];
  concepts: readonly ConceptDescription[];
  findings: readonly Finding[];
  requiredSubmodels?: readonly string[];
  /**
   * 설비 한 대 파일인가, 공정·회사 파일인가 — 넣는 것이 다르다(사용자 2026-09-08):
   * 설비 = 서브모델(내용) · 부품(구성) / 공정 = 설비(올려 둔 파일) · 층(공정·라인) · 서브모델(공정 자체의 내용)
   */
  unit: 'equipment' | 'composite';
  onAddSubmodel: () => void;
  onAddAsset: () => void;
  onAddGroup: () => void;
  /** 공정 파일이면 구성 패널이 여기(넣기 줄 바로 아래)에 온다 — 구성이 곧 공정의 정체다 */
  children?: React.ReactNode;
  /** IRI 이관 대장 건수 — 「자동 고치기」가 IDTA 공식 IRI를 자체 IRI로 옮긴 것. 0이면 안 그린다 */
  ledgerCount?: number;
  onRevertLedger?: () => void;
  /** 번역기 — 사전에 없으면 한국어 그대로 (i18n.ts) */
  t: (text: string) => string;
}

export function Summary({
  fileName,
  composition,
  totals,
  shells,
  submodels,
  concepts,
  findings,
  requiredSubmodels,
  unit,
  onAddSubmodel,
  onAddAsset,
  onAddGroup,
  children,
  ledgerCount = 0,
  onRevertLedger,
  t,
}: Props): React.JSX.Element {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const fixable = errors.filter((f) => f.fixable).length;
  const fixableWarnings = warnings.filter((f) => f.fixable).length;
  const shell = shells[0];
  const present = new Set(submodels.map((s) => s.idShort));
  // 🔴 새로 만든 뼈대는 서브모델이 전부 비어도 위반 0건이다(KOSMO는 형식만 본다) — 이름까지 집어서 알린다
  const emptyOnes = submodels.filter((sm) => countElements([sm]) === 0).map((sm) => sm.idShort ?? sm.id);
  const missing = (requiredSubmodels ?? []).filter((name) => !present.has(name));

  return (
    <div className="summary">
      <h2>
        {fileName}
        {/* 어느 도구로 쓰는 중인지 — 설비 한 대 편집인지 공장 구성인지 한눈에 */}
        <span
          className={`unit-badge ${unit}`}
          title={
            unit === 'equipment'
              ? t('설비 한 대의 AAS — 서브모델과 부품을 넣습니다')
              : t('공정·회사(묶음)의 AAS — 설비와 층을 넣습니다')
          }
        >
          {unit === 'equipment' ? t('설비') : t('공정·회사')}
        </span>
      </h2>
      <p className="sub">{shell?.idShort ?? t('장비 정보 없음')}</p>

      {/* 🔴 넣을 수 있는 것을 종류별로 — 「＋ 넣기」 하나로는 무엇이 들어가는지 안 보였다(사용자 2026-09-08) */}
      <div className="add-row">
        <span className="dim">{t('이 파일에 넣기')}</span>
        {unit === 'equipment' ? (
          <>
            <button onClick={onAddSubmodel} title={t('명판·기술사양·운전데이터 같은 내용 묶음')}>{t('＋ 서브모델')}</button>
            <button onClick={onAddAsset} title={t('이 설비를 이루는 부품(BoM) — HierarchicalStructures에 들어갑니다')}>{t('＋ 부품')}</button>
          </>
        ) : (
          <>
            <button onClick={onAddAsset} title={t('올려 둔 설비 .aasx를 이 공정에 넣습니다')}>{t('＋ 설비')}</button>
            <button onClick={onAddGroup} title={t('파일 없는 층 — 공정·라인. 회사 바로 밑에 만듭니다')}>{t('＋ 공정')}</button>
            <button onClick={onAddSubmodel} title={t('이 공정 자체의 내용(명판 등)')}>{t('＋ 서브모델')}</button>
          </>
        )}
      </div>
      {children}

      <div className="tiles">
        {composition ? (
          <>
            <div className="tile">
              <b>{composition.groups}</b>
              <span>{t('공정·그룹')}</span>
            </div>
            <div className="tile">
              <b>{composition.assets}</b>
              <span>{composition.units > composition.assets ? fill(tr('설비 (총 {0}대)'), { 0: composition.units }) : tr('설비')}</span>
            </div>
            <div className="tile">
              <b>{submodels.length}</b>
              <span>{t('자체 서브모델')}</span>
            </div>
          </>
        ) : (
          <>
            <div className="tile">
              <b>{submodels.length}</b>
              <span>{t('서브모델')}</span>
            </div>
            <div className="tile">
              <b>{countElements(submodels)}</b>
              <span>{t('요소')}</span>
            </div>
            <div className="tile">
              <b>{concepts.length}</b>
              <span>ConceptDescription</span>
            </div>
          </>
        )}
      </div>

      {composition && totals && (
        <div className="tiles tiles-sub">
          <div className="tile">
            <b>{totals.submodels}</b>
            <span>{t('서브모델 (설비 포함)')}</span>
          </div>
          <div className="tile">
            <b>{totals.elements}</b>
            <span>{t('요소 (설비 포함)')}</span>
          </div>
          <div className="tile">
            <b>{totals.concepts}</b>
            <span>ConceptDescription</span>
          </div>
        </div>
      )}
      {composition && totals && totals.unopened > 0 && (
        <p className="hint"><T k={'파일이 안 열린 설비 {0}건은 합계에 빠져 있습니다 — 열면 합산됩니다.'} v={[totals.unopened]} /></p>
      )}

      <div className={`verdict ${errors.length === 0 ? 'ok' : 'bad'}`}>
        {errors.length === 0 ? (
          <>
            <b>{fill(t('규칙 위반 {n}건'), { n: 0 })}</b>
            <span>
              {t('규칙 검사를 통과했습니다.')}{' '}
              {warnings.length === 0
                ? t('경고도 없습니다.')
                : fixableWarnings > 0
                  ? fill(t('경고 {n}건 중 {m}건은 위 「자동 고치기」로 함께 지워집니다.'), {
                      n: warnings.length,
                      m: fixableWarnings,
                    })
                  : fill(t('경고 {n}건은 확인만 하십시오.'), { n: warnings.length })}
              {emptyOnes.length > 0 && (
                <>
                  {' '}<T k={'<b>다만 비어 있는 서브모델 {0}개</b>({1}) — 규칙은 형식만 봅니다. 트리에서 골라 「요소 추가」, 또는 위 「다른 파일에서 가져오기」로 채우십시오.'} v={[emptyOnes.length, emptyOnes.join(' · ')]} /></>
              )}
            </span>
          </>
        ) : (
          <>
            <b>{fill(t('규칙 위반 {n}건'), { n: errors.length })}</b>
            <span>
              <T k={'{0}위 「위반 {1}건」을 누르면 목록이 열리고, 항목을 누르면 그 요소로 갑니다.'} v={[fixable > 0
                ? fill(tr('그중 {0}건은 위 「자동 고치기」로 바로 교정됩니다. '), { 0: fixable })
                : tr('자동으로 고칠 수 있는 것은 없습니다 — 사람이 봐야 합니다. '), errors.length]} /></span>
          </>
        )}
      </div>


      {/* 이관 대장 — "옮기고 끝"이 아니라는 것을 보이는 자리. 되돌리기는 규정 해석이 바뀌었을 때(사용자 2026-09-11) */}
      {ledgerCount > 0 && (
        <p className="hint ledger">
          <T k={'IDTA 공식 IRI를 자체 IRI로 옮긴 것 <b>{0}건</b>이 <b>이관 대장</b>에 있습니다(KOSMO 우선 정책 — Validator가 공식 IRI를 거부하기 때문). 내려받는 .aasx 안에 함께 들어가고 검증 결과서에도 실립니다.'} v={[ledgerCount]} />
          {onRevertLedger && (
            <>
              {' '}
              <button
                className="link"
                title={tr('옮겼던 IDTA 공식 IRI를 원래대로 되돌립니다 — 지금 정책(KOSMO 우선)이면 다시 위반으로 잡힙니다')}
                onClick={onRevertLedger}
              >
                {tr('원본 IRI로 되돌리기')}
              </button>
            </>
          )}
        </p>
      )}
      {missing.length > 0 && (
        <p className="hint"><T k={'필수 서브모델이 빠졌습니다: <b>{0}</b> — 「다른 파일에서 가져오기」로 채울 수 있습니다.'} v={[missing.join(', ')]} /></p>
      )}

      <p className="hint">{t('왼쪽 트리에서 요소를 고르면 여기에서 값을 고칠 수 있습니다.')}</p>
    </div>
  );
}
