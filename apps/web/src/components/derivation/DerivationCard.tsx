/**
 * Type-file card — shows in the file summary "which type this unit came from, and whether the type has changed".
 *
 * Files made by splitting per unit are linked from the start. Units made before that pick their type file here to link —
 * the baseline is the type at the moment of linking, so values that differed before then stay as this unit's own values.
 * The server decides (apps/api/src/routes/derivation.ts); this only displays and lets the user choose.
 */
import { useEffect, useState } from 'react';
import { api, type DerivationView, type PackageDescription } from '../../api.js';
import { tr, fill } from '../../i18n.js';
import { DerivationDialog } from './DerivationDialog.js';

interface Props {
  packageId: string;
  packages: readonly PackageDescription[];
  busy: boolean;
  /** In-progress indicator and error classification — useCore's run */
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  /** After applying, reload the tree, findings, and undo list */
  loadPackage: (packageId: string) => Promise<void>;
  setNotice: (notice: string) => void;
  /**
   * A value that changes every time the file is reloaded (submodel revision table) — when it changes, the card reloads too.
   * Without it, undoing the apply via the header "Undo" leaves the card stuck at "no changes" (measured on screen, 2026-10-14).
   */
  revisions: Readonly<Record<string, number>>;
}

export function DerivationCard({ packageId, packages, busy, run, loadPackage, setNotice, revisions }: Props): React.JSX.Element | null {
  const [view, setView] = useState<DerivationView>();
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [source, setSource] = useState('');
  const [unlinking, setUnlinking] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .derivation(packageId)
      .then((result) => alive && setView(result))
      .catch(() => alive && setView(undefined)); // If it cannot be read, do not draw the card — do not block other work
    return () => {
      alive = false;
    };
  }, [packageId, tick, revisions]);

  if (!view) return null;
  const refresh = (): void => setTick((n) => n + 1);
  const others = packages.filter((item) => item.packageId !== packageId);

  const apply = async (keys: string[]): Promise<void> => {
    const result = await run(() => api.applyDerivation(packageId, keys));
    if (!result) return;
    setOpen(false);
    await loadPackage(packageId);
    refresh();
    setNotice(fill(tr('형식 변경 {0}줄을 반영했습니다 — 「되돌리기」로 되돌릴 수 있습니다'), { 0: result.applied }));
  };
  const link = async (): Promise<void> => {
    if (!source) return;
    const done = await run(() => api.linkDerivation(packageId, source));
    if (!done) return;
    setLinking(false);
    refresh();
  };
  const unlink = async (): Promise<void> => {
    await run(() => api.unlinkDerivation(packageId));
    setUnlinking(false);
    refresh();
  };

  if (!view.linked) {
    if (others.length === 0) return null;
    return (
      <div className="derivation-card off">
        {linking ? (
          <div className="derivation-link">
            <select aria-label={tr('형식 파일')} value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">{tr('형식 파일 고르기')}</option>
              {others.map((item) => (
                <option key={item.packageId} value={item.packageId}>
                  {item.name ?? item.packageId}
                </option>
              ))}
            </select>
            <button disabled={busy || !source} onClick={() => void link()}>
              {tr('연결')}
            </button>
            <button className="link" onClick={() => setLinking(false)}>
              {tr('취소')}
            </button>
          </div>
        ) : (
          <button
            className="link"
            title={tr('이 파일이 어떤 형식 파일에서 나온 호기라면 연결해 두십시오 — 형식이 바뀌면 여기서 받아 옵니다')}
            onClick={() => setLinking(true)}
          >
            {tr('형식 파일에 연결…')}
          </button>
        )}
      </div>
    );
  }

  const name = view.sourceName ?? '';
  const applyCount = view.counts?.apply ?? 0;
  const skipCount = view.counts?.skip ?? 0;
  return (
    <div className={`derivation-card${view.sourceMissing ? ' missing' : applyCount > 0 ? ' pending' : ''}`}>
      <span className="dim">{tr('형식 파일')}</span> <b>{name}</b>
      {view.sourceMissing ? (
        <span className="state">{tr('— 보관함에 없습니다. 다른 형식 파일에 다시 연결하거나 연결을 끊으십시오.')}</span>
      ) : applyCount > 0 ? (
        <button className="primary" disabled={busy} onClick={() => setOpen(true)}>
          {fill(tr('형식 변경 확인 ({0})'), { 0: applyCount })}
        </button>
      ) : (
        <span className="state dim">{tr('— 반영할 형식 변경이 없습니다')}</span>
      )}
      {skipCount > 0 && !view.sourceMissing && (
        <span className="state dim">{fill(tr('· 이 호기에서 고쳐 그대로 둔 곳 {0}'), { 0: skipCount })}</span>
      )}
      {unlinking ? (
        <span className="state">
          {tr('끊으면 형식 변경을 더 받지 않습니다.')}{' '}
          <button className="link" disabled={busy} onClick={() => void unlink()}>
            {tr('끊기')}
          </button>{' '}
          <button className="link" onClick={() => setUnlinking(false)}>
            {tr('취소')}
          </button>
        </span>
      ) : (
        <button className="link" onClick={() => setUnlinking(true)}>
          {tr('연결 끊기')}
        </button>
      )}
      {open && view.changes && (
        <DerivationDialog sourceName={name} changes={view.changes} busy={busy} onApply={(keys) => void apply(keys)} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
