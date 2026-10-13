/**
 * 형식 파일 카드 — 파일 요약에서 「이 호기는 어느 형식에서 나왔고, 형식이 바뀐 것이 있나」를 보여 준다.
 *
 * 호기별로 나누기로 만든 파일은 처음부터 연결돼 있다. 그 전에 만든 호기는 여기서 형식 파일을 골라 연결한다 —
 * 기준은 연결하는 때의 형식이라, 그 전에 달라진 값은 이 호기 고유 값으로 남는다.
 * 서버가 판정하고(apps/api/src/routes/derivation.ts) 여기서는 보여 주고 고르게만 한다.
 */
import { useEffect, useState } from 'react';
import { api, type DerivationView, type PackageDescription } from '../../api.js';
import { tr, fill } from '../../i18n.js';
import { DerivationDialog } from './DerivationDialog.js';

interface Props {
  packageId: string;
  packages: readonly PackageDescription[];
  busy: boolean;
  /** 처리 중 표시와 오류 분류 — useCore 의 run */
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  /** 반영한 뒤 트리·지적·되돌리기 목록을 다시 읽는다 */
  loadPackage: (packageId: string) => Promise<void>;
  setNotice: (notice: string) => void;
  /**
   * 파일을 다시 읽을 때마다 바뀌는 값(서브모델 리비전 표) — 이것이 바뀌면 카드도 다시 읽는다.
   * 없으면 머리글 「되돌리기」로 반영을 되돌려도 카드가 「변경 없음」에 머문다(2026-10-14 화면 실측).
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
      .catch(() => alive && setView(undefined)); // 못 읽으면 카드를 그리지 않는다 — 다른 일을 막지 않는다
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
