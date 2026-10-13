/**
 * 첫 화면 — 열린 파일이 없거나, 로고를 눌러 나왔을 때(보는 파일 없음).
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화). 빈 세 칸만 띄워 두면 처음 쓰는 사람은 손댈 곳을 찾지 못한다.
 */
import type { PackageDescription, Policy } from '../api.js';
import { NewPackage } from '../components/NewPackage.js';
import type { DraftNode } from '../components/HierarchyTree.js';
import { tr, type Lang } from '../i18n.js';

interface Props {
  t: (text: string) => string;
  lang: Lang;
  packages: PackageDescription[];
  /** 「새로 만들기」 양식이 열려 있다 */
  creating: boolean;
  busy: boolean;
  policy?: Policy;
  onOpenPackage: (packageId: string) => void;
  onPickFile: () => void;
  onPickBundle: () => void;
  onStartNew: () => void;
  onCancelNew: () => void;
  onOpenSample: () => void;
  onImportFile: (file: File) => Promise<string | undefined>;
  onCreate: (name: string, extras: string[], unit: 'equipment' | 'composite', tree: DraftNode[]) => void;
}

export function Welcome({ t, lang, packages, creating, busy, policy, onOpenPackage, onPickFile, onPickBundle, onStartNew, onCancelNew, onOpenSample, onImportFile, onCreate }: Props): React.JSX.Element {
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
        🔴 이어서 작업하기 — 로고로 나왔거나 다시 들어온 사람이 처음 보는 자리다.
           전에는 「AASX 파일 열기」만 커서 **같은 파일을 또 올려** 목록에 사본이 쌓였다(2026-09-09 검토).
           올려 둔 것이 있으면 그 목록이 먼저다. 파란 버튼도 이쪽으로 넘긴다
      */}
      {packages.length > 0 && !creating && (
        /*
          🔴 접어 둔다(2026-10-01 사용자 요청) — 파일이 16건 쌓이자 첫 화면을 목록이 덮었다.
             `details`를 쓰는 이유: 펼침·접힘, 키보드(Enter·Space), 화면 낭독기 안내가
             브라우저에 이미 들어 있다. 직접 만들면 그걸 전부 다시 해야 한다.
             건수를 제목에 남겨 접혀 있어도 "여기 있다"가 보이게 한다.
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
        {/* 파란 배경은 "지금 하는 일"을 따라간다 — 새로 만들기를 누르면 그쪽이 파랗다.
            올려 둔 파일이 있으면 위 목록이 주인공이라 둘 다 보통 버튼이다 */}
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
          🔴 번들 열기 — 헤더와 같은 세 갈래를 첫 화면에도 둔다(2026-10-01 사용자 요청).
             첫 화면에 둘뿐이라 "번들은 어디서 여나"를 헤더에서 찾아야 했다.
             헤더의 것과 **같은 파일 고르개**(bundleInput)를 쓴다 — 두 개를 두면 갈라진다.
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
