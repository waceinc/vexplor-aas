/**
 * Start screen — when no file is open, or after clicking the logo to leave (no file being viewed).
 * Split out of App.tsx (componentization, 2026-10-13). Showing three empty panes leaves first-time users with nowhere to start.
 */
import type { PackageDescription, Policy } from '../api.js';
import { NewPackage } from '../components/NewPackage.js';
import type { DraftNode } from '../components/HierarchyTree.js';
import { tr, type Lang } from '../i18n.js';
import { dppTemplates } from './dppTemplates.js';

interface Props {
  t: (text: string) => string;
  lang: Lang;
  packages: PackageDescription[];
  /** The "New" form is open */
  creating: boolean;
  busy: boolean;
  policy?: Policy;
  onOpenPackage: (packageId: string) => void;
  onPickFile: () => void;
  onPickBundle: () => void;
  onStartNew: () => void;
  onCancelNew: () => void;
  onOpenSample: () => void;
  /** Open one of the official IDTA passport templates (file name in public/samples/idta) */
  onOpenDppTemplate: (file: string) => void;
  onImportFile: (file: File) => Promise<string | undefined>;
  onCreate: (name: string, extras: string[], unit: 'equipment' | 'composite', tree: DraftNode[]) => void;
}

export function Welcome({ t, lang, packages, creating, busy, policy, onOpenPackage, onPickFile, onPickBundle, onStartNew, onCancelNew, onOpenSample, onOpenDppTemplate, onImportFile, onCreate }: Props): React.JSX.Element {
  return (
    <div className="welcome">
      <span className="wordmark big">VEXPLOR</span>
      <h1>AAS Studio</h1>
      <p>
        {packages.length > 0
          ? t('서버에 올려 둔 파일이 있습니다 — 아래에서 골라 이어서 작업하거나, 새 파일을 엽니다.')
          : t('AASX 파일을 열면 계층 트리·규칙 지적·수집이 한 화면에 뜹니다.')}
      </p>
      {/*
        Important: Continue working — the first thing seen by someone who left via the logo or came back.
           Previously only "Open AASX file" was prominent, so people **uploaded the same file again** and copies piled up in the list (review, 2026-09-09).
           If files are already uploaded, that list comes first. The blue button moves here too
      */}
      {packages.length > 0 && !creating && (
        /*
          Important: collapsed (user request, 2026-10-01) — once 16 files piled up, the list took over the start screen.
             Why `details`: expand/collapse, keyboard (Enter, Space) and screen-reader announcements
             are built into the browser. A custom widget would have to redo all of that.
             The count stays in the title so "it's here" is visible even when collapsed.
        */
        <details className="welcome-files">
          <summary className="welcome-files-title">
            {t('이어서 작업하기')} — {t('올려 둔 파일')} {packages.length}
            {lang === 'ko' ? tr('건') : ''}
          </summary>
          <ul>
            {packages.map((item) => (
              <li key={item.packageId}>
                <button
                  className="welcome-file"
                  disabled={busy}
                  onClick={() => onOpenPackage(item.packageId)}
                  title={t('이 파일을 엽니다')}
                >
                  <b>{item.name ?? item.packageId}</b>
                  {item.assetName && <span className="dim">{item.assetName}</span>}
                  {item.updatedAt && <span className="dim file-date">{item.updatedAt.slice(0, 10)}</span>}
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">
            {t('같은 파일을 다시 올리면 사본이 하나 더 생깁니다 — 하던 파일은 여기서 고르십시오.')}
          </p>
        </details>
      )}
      <div className="row-buttons">
        {/* The blue background follows "what you are doing now" — clicking New makes that one blue.
            When files are already uploaded, the list above is the focus, so both are plain buttons */}
        <button
          className={creating || packages.length > 0 ? 'big' : 'primary big'}
          onClick={onPickFile}
        >
          {t('AASX 파일 열기')}
        </button>
        <button
          className={creating ? 'primary big' : 'big'}
          onClick={onStartNew}
        >
          {t('새로 만들기')}
        </button>
        {/*
          Important: Open bundle — the start screen gets the same three options as the header (user request, 2026-10-01).
             With only two on the start screen, users had to hunt in the header for "where do I open a bundle?".
             Uses **the same file picker** (bundleInput) as the header — two separate pickers would drift apart.
        */}
        <button className="big" disabled={busy} onClick={onPickBundle}>
          {t('번들 열기')}
        </button>
      </div>
      {packages.length === 0 && !creating && (
        <p className="welcome-sample">
          {tr('AASX 파일이 아직 없다면 — ')}
          <button
            className="link"
            disabled={busy}
            title={tr('다 채워진 설비 1종과 공정 구성을 열어 둘러봅니다 — 고쳐도 되는 연습용입니다')}
            onClick={onOpenSample}
          >
            {tr('견본으로 시작하기')}
          </button>
        </p>
      )}
      {/*
        Important: passport templates — shown even when files are already uploaded, because a passport is real work, not practice.
           Collapsed like the file list so it does not take over the start screen; same look (welcome-files), no new styles.
           The wording stops at "write and check" — opening a template does not make a product EU DPP compliant.
      */}
      {!creating && (
        <details className="welcome-files welcome-dpp">
          <summary className="welcome-files-title">{tr('제품 여권(DPP) 서식으로 시작하기')}</summary>
          <ul>
            {dppTemplates().map((item) => (
              <li key={item.file}>
                <button
                  className="welcome-file"
                  disabled={busy}
                  onClick={() => onOpenDppTemplate(item.file)}
                  title={tr('IDTA 공식 서식을 원본 그대로 엽니다 — 값은 비어 있습니다')}
                >
                  <b>{item.label}</b>
                  <span className="dim">{item.spec} v{item.version}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">
            {tr('IDTA 공식 서브모델 서식(CC BY 4.0)입니다. 여권 데이터를 쓰고 필수 항목을 검사하는 데까지 돕습니다 — EU 규정 적합 판정은 하지 않습니다.')}
          </p>
        </details>
      )}
    {creating && (
        <NewPackage
          t={t}
          {...(policy ? { policy } : {})}
          busy={busy}
          onCancel={onCancelNew}
          candidates={packages}
          onImportFile={onImportFile}
          onCreate={onCreate}
        />
      )}
    </div>
  );
}
