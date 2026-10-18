/**
 * Reference bundle — the screen that treats one process file as "one complete submission package".
 *
 * Answers on one screen the three questions an evaluator asks (reference bundle plan §2.3).
 *  (1) What is inside — process → equipment composition, and per machine its file · version · pre-check
 *  (2) Does it connect — do the machines together hold the inputs (operating data) for the process KPIs (common-item matrix)
 *  (3) Can it be trusted — on export, each file's SHA256 is stamped into the manifest
 * And it guards two more (added after verification on 2026-09-30).
 *  (4) Instead of a demo — it carries the collection record (evidence of real operation), and reopening the bundle carries it over
 *  (5) Documents people add — Use-Case, guidance and reference material uploaded here survive opening and re-exporting the bundle
 *
 * Important: the tool does not write documents. Nor does it guess synonyms — when the semanticId is the same but the names differ,
 *    or the names are the same but the semanticId differs, it shows a "Point to check" and a person decides.
 * Important: the KOSMO Validator is the check you get **when making per-equipment AASX** — there is no official validator for bundles (plan §2.3).
 *    The check marks here are reference marks from this tool re-checking the models put in the bundle. Do not word it so it reads
 *    like "the bundle is also judged by the Validator" (user remark, 2026-09-30).
 *
 * 2026-10-13 componentization — each section was split into a part under bundle/. This file reads the bundle, gathers the numbers and places the sections.
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog.js';
import { api, type BundleView } from '../api.js';
import { tr } from '../i18n.js';
import { T } from './T.js';
import { AttachmentSection } from './bundle/AttachmentSection.js';
import { BundleFindings } from './bundle/BundleFindings.js';
import { BundleForm } from './bundle/BundleForm.js';
import { BundleMembers } from './bundle/BundleMembers.js';
import { BundleStats } from './bundle/BundleStats.js';
import { EvidenceSection } from './bundle/EvidenceSection.js';
import { LinkageMatrix } from './bundle/LinkageMatrix.js';

interface Props {
  packageId: string;
  onOpenPackage: (packageId: string) => void;
  onClose: () => void;
}

export function BundlePanel({ packageId, onOpenPackage, onClose }: Props): React.JSX.Element {
  const [view, setView] = useState<BundleView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('RB01');
  const [title, setTitle] = useState('');
  const [version, setVersion] = useState('1.0.0');
  /** Evidence level — with auto the server proposes (C only when there is simulation alone) */
  const [evidenceLevel, setEvidenceLevel] = useState('auto');
  /** Evidence period — empty means all. For excluding noise accumulated during testing */
  const [evidenceMinutes, setEvidenceMinutes] = useState('');
  /** Re-read after an attachment is uploaded or removed */
  const [tick, setTick] = useState(0);
  /** Highlighted matrix row — hovering the points-to-check list highlights the same row */
  const [focus, setFocus] = useState<string>();

  useEffect(() => {
    let alive = true;
    api
      .bundle(packageId, evidenceMinutes)
      .then((result) => alive && setView(result))
      .catch((reason: Error) => alive && setError(reason.message));
    return () => {
      alive = false;
    };
  }, [packageId, evidenceMinutes, tick]);

  if (error) {
    return (
      <Dialog label={tr('레퍼런스 번들')} onClose={onClose} close={{ text: tr('닫기') }}>
        <div className="bundle-body">
          <h2>{tr('레퍼런스 번들')}</h2>
          <p className="error-text">{error}</p>
        </div>
      </Dialog>
    );
  }

  const members = view?.members ?? [];
  const ready = members.filter((m) => m.packageId);
  const planned = members.filter((m) => !m.packageId);
  const failing = ready.filter((m) => m.lint && !m.lint.passed);
  const common = (view?.linkage.items ?? []).filter((item) => item.coverage >= 2).length;
  const warnings = (view?.linkage.findings ?? []).filter((f) => f.severity === 'warning').length;
  const category = view?.categories[code] ?? '';
  const demos = ready.filter((m) => m.demo);
  const evidence = view?.evidence;
  const carried = (evidence?.sources.length ?? 0) === 0 ? evidence?.carried : undefined;
  const shownSources = (evidence?.sources.length ?? 0) > 0 ? evidence!.sources : (carried?.entries ?? []);
  const samples = shownSources.reduce((sum, source) => sum + source.samples, 0);
  const effectiveLevel =
    evidenceLevel === 'auto'
      ? (evidence?.suggested ?? carried?.level ?? null)
      : evidenceLevel === 'none'
        ? null
        : evidenceLevel;
  const aasd120 = ready.reduce((sum, m) => sum + (m.lint?.aasd120 ?? 0), 0);

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.downloadBundle(packageId, {
        code,
        title: title.trim() || category,
        version,
        evidence: evidenceLevel,
        evidenceMinutes,
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog className="wide" label={tr('레퍼런스 번들')} onClose={onClose} close={{ text: tr('닫기') }}>
      <div className="bundle-body">
        <h2><T k={'레퍼런스 번들 {0}'} v={[<span className="dim">— {view?.process.name ?? tr('읽는 중…')}</span>]} />
        </h2>

        {/* Export — one blue button per screen */}
        <BundleForm
          view={view}
          busy={busy}
          readyCount={ready.length}
          code={code}
          setCode={setCode}
          title={title}
          setTitle={setTitle}
          category={category}
          version={version}
          setVersion={setVersion}
          evidenceLevel={evidenceLevel}
          setEvidenceLevel={setEvidenceLevel}
          evidenceMinutes={evidenceMinutes}
          setEvidenceMinutes={setEvidenceMinutes}
          onExport={onExport}
        />

        {demos.length > 0 && (
          <p className="bundle-demo-note"><T k={'<b>시연본 {0}대 포함</b> — 수집 연결(AID)이 붙어 있습니다. 시연용으로는 맞지만,<b> 정식 번들</b>에는 연결이 없는 원본 참조모델을 넣으십시오. 내보내면 README와 manifest에도 표시됩니다.'} v={[demos.length]} /></p>
        )}

        {/* At a glance — five numbers */}
        <BundleStats
          members={members.length}
          ready={ready.length}
          planned={planned.length}
          failing={failing.length}
          aasd120={aasd120}
          common={common}
          warnings={warnings}
          samples={samples}
          carried={carried !== undefined}
          effectiveLevel={effectiveLevel}
        />

        <BundleMembers view={view} members={members} onOpenPackage={onOpenPackage} />
        <LinkageMatrix view={view} common={common} focus={focus} setFocus={setFocus} />
        <EvidenceSection shownSources={shownSources} carried={carried} />
        <AttachmentSection packageId={packageId} view={view} onChanged={() => setTick((n) => n + 1)} />
        <BundleFindings view={view} setFocus={setFocus} />

        <p className="dim small bundle-foot"><T k={'내보낸 ZIP: <code>00_공정구성 · 01_UseCase문서 · 02_참조모델 · 03_가이던스 · 04_데이터연계정의 · 05_샘플데이터 · 06_검증결과</code>+ <code>bundle-manifest.json</code>(파일마다 SHA256) + <code>README.md</code>. 문서는 작성 안내만 들어갑니다.<br/>✓ 사전 점검은 번들에 넣은 모델을 이 도구가 <b>다시 확인한 참고 표시</b>입니다. 모델의 공식 검증(KOSMO Validator)은 장비별 AASX를 만들 때 받는 것이라 번들에서 따로 하지 않습니다 — 번들 자체의 확인은 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 합니다.'} /></p>
      </div>
    </Dialog>
  );
}
