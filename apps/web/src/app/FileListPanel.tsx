/**
 * File list card — see accumulated files at a glance and open or delete them (check several to act at once).
 * Split out of App.tsx (componentization, 2026-10-13). Delete confirmation and link warnings are handled by App's deletePackages.
 */
import type { PackageDescription } from '../api.js';
import { T } from '../components/T.js';
import { fill, tr } from '../i18n.js';
import { PanelHead } from '../ui/PanelHead.js';

interface Props {
  packages: PackageDescription[];
  /** File currently being viewed — marked "← viewing" next to its name */
  packageId?: string;
  picked: ReadonlySet<string>;
  busy: boolean;
  onPick: (next: ReadonlySet<string>) => void;
  onOpen: (packageId: string) => void;
  onDelete: (packageIds: string[]) => void;
  onClose: () => void;
}

export function FileListPanel({ packages, packageId, picked, busy, onPick, onOpen, onDelete, onClose }: Props): React.JSX.Element {
  return (
    <div className="file-list">
      <PanelHead title={<T k={'열린 파일 {0}건'} v={[packages.length]} />} onClose={onClose} closeText={tr('닫기')} />
      {/* Several at once — deleting test leftovers one by one was tiring (user, 2026-09-09) */}
      <label className="file-pick-all">
        <input
          type="checkbox"
          aria-label={tr('전체 고르기')}
          checked={packages.length > 0 && packages.every((item) => picked.has(item.packageId))}
          onChange={(event) =>
            onPick(event.target.checked ? new Set(packages.map((item) => item.packageId)) : new Set())
          }
        />
        <span className="dim">{tr('전체 고르기')}</span>
      </label>
      <ul>
        {packages.map((item) => (
          <li key={item.packageId}>
            <input
              type="checkbox"
              aria-label={fill(tr('{0} 고르기'), { 0: item.name ?? item.packageId })}
              checked={picked.has(item.packageId)}
              disabled={busy}
              onChange={(event) =>
                onPick((() => {
                  const next = new Set(picked);
                  if (event.target.checked) next.add(item.packageId);
                  else next.delete(item.packageId);
                  return next;
                })())
              }
            />
            <button
              className={`link file-name${item.packageId === packageId ? ' current' : ''}`}
              disabled={busy}
              onClick={() => onOpen(item.packageId)}
              title={tr('이 파일 열기')}
              // The "viewing" marker is drawn by CSS ::after — the text goes through the translator and is passed as an attribute (Korean written in CSS would remain on the English screen)
              data-current-label={tr(' ← 보는 중')}
            >
              {item.name ?? item.packageId}
            </button>
            {item.assetName && <span className="dim">{item.assetName}</span>}
            {item.updatedAt && (
              <span className="dim file-date">{item.updatedAt.slice(0, 10)}</span>
            )}
            <button
              className="link danger"
              disabled={busy}
              title={tr('서버에서 이 파일을 지웁니다 — 되돌릴 수 없습니다. 내려받아 둔 .aasx는 남습니다')}
              onClick={() => onDelete([item.packageId])}
            >
              {tr('지우기')}
            </button>
          </li>
        ))}
      </ul>
      <div className="file-bulk">
        <button
          className="danger"
          disabled={busy || picked.size === 0}
          onClick={() => onDelete([...picked])}
          title={tr('체크한 파일을 한 번에 지웁니다')}
        ><T k={'고른 {0}건 지우기'} v={[picked.size]} /></button>
        <span className="hint">{tr('지우면 되돌릴 수 없습니다. 내려받아 둔 .aasx 파일은 남습니다.')}</span>
      </div>
    </div>
  );
}
