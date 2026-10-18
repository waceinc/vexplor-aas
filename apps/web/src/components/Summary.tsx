/**
 * File summary — keeps the center pane from sitting idle before an element is selected.
 *
 * Right after opening a file you need to know two things: **what is in it · does it pass.**
 * Only after seeing the screen did we notice this area was entirely empty (2026-08-24).
 * The "next steps" list was removed on 2026-09-08 — user: "it's obvious, so it can be deleted". Only the empty-submodel notice stays in the verdict line.
 */
import { countElements } from '../model.js';
import { fill } from '../i18n.js';
import type { ConceptDescription, Finding, Shell, Submodel } from '../model.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  fileName: string;
  /**
   * Composition totals for a bundle file — when present, shown instead of the raw number (n elements).
   * Important: in a bundle, "8 elements" also counts process nodes, links (HasPart), and settings,
   *    so it disagrees with the composition people see (2 processes · 3 equipment) (user report, 2026-08-26).
   */
  composition?: { lines?: number; groups: number; assets: number; units: number };
  /**
   * Content totals — submodels, elements, and CDs summed including equipment files linked with ⚙.
   * Important: this is not re-showing the file's own raw numbers (that proved confusing —
   *    "8 elements" was the sum of process nodes and links). It is only meaningful as the sum of everything visible in the tree.
   */
  totals?: { submodels: number; elements: number; concepts: number; unopened: number };
  /** Whether the representative photo is still a placeholder — unused since "next steps" was removed (2026-09-08). Kept for caller compatibility */
  thumbnailPlaceholder?: boolean;
  shells: readonly Shell[];
  submodels: readonly Submodel[];
  concepts: readonly ConceptDescription[];
  findings: readonly Finding[];
  requiredSubmodels?: readonly string[];
  /**
   * Single-equipment file vs. process/company file — they take different things (user, 2026-09-08):
   * equipment = submodels (content) · parts (composition) / process = equipment (placed files) · levels (process, line) · submodels (the process's own content)
   */
  unit: 'equipment' | 'composite';
  onAddSubmodel: () => void;
  onAddAsset: () => void;
  onAddGroup: () => void;
  /** For a process file the composition panel comes here (right below the add row) — the composition is what defines the process */
  children?: React.ReactNode;
  /** Count of IRI migration ledger entries — what "auto fix" moved from official IDTA IRIs to our own IRIs. Not drawn when 0 */
  ledgerCount?: number;
  onRevertLedger?: () => void;
  /** Type-file card (components/derivation) — where an instance file pulls in changes from its type. Right below the verdict line */
  derivation?: React.ReactNode;
  /** Translator — falls back to the Korean as-is when missing from the dictionary (i18n.ts) */
  t: (text: string) => string;
}

export function Summary({
  derivation,
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
  // Important: a freshly created skeleton has 0 violations even if every submodel is empty (KOSMO checks form only) — so name them explicitly
  const emptyOnes = submodels.filter((sm) => countElements([sm]) === 0).map((sm) => sm.idShort ?? sm.id);
  const missing = (requiredSubmodels ?? []).filter((name) => !present.has(name));

  return (
    <div className="summary">
      <h2>
        {fileName}
        {/* Which tool you are working in — single-equipment editing or plant composition, at a glance */}
        <span
          className={`unit-badge ${unit}`}
          title={
            unit === 'equipment'
              ? t('설비 한 대의 AAS — 서브모델과 부품을 넣습니다')
              : t('공정·회사(묶음)의 AAS — 설비와 공정·라인을 넣습니다')
          }
        >
          {unit === 'equipment' ? t('설비') : t('공정·회사')}
        </span>
      </h2>
      <p className="sub">{shell?.idShort ?? t('장비 정보 없음')}</p>

      {/* Important: what can be added, by kind — a single "+ Add" did not show what goes in (user, 2026-09-08) */}
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
            <button onClick={onAddGroup} title={t('파일 없는 단계 — 공정·라인. 회사 바로 밑에 만듭니다')}>{t('＋ 공정')}</button>
            <button onClick={onAddSubmodel} title={t('이 공정 자체의 내용(명판 등)')}>{t('＋ 서브모델')}</button>
          </>
        )}
      </div>
      {children}

      <div className="tiles">
        {composition ? (
          <>
            {(composition.lines ?? 0) > 0 && (
              <div className="tile">
                <b>{composition.lines}</b>
                <span>{t('라인')}</span>
              </div>
            )}
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
      {derivation}

      {/* Migration ledger — the place that shows this is not "move and forget". Revert is for when the rule interpretation changes (user, 2026-09-11) */}
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
