/**
 * 파일 목록 카드 — 쌓인 파일을 한눈에 보고 열거나 지운다(체크해서 한꺼번에).
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화). 지우기 확인·연결 경고는 App 의 deletePackages 가 한다.
 */
import type { PackageDescription } from '../api.js';
import { T } from '../components/T.js';
import { fill, tr } from '../i18n.js';
import { PanelHead } from '../ui/PanelHead.js';

interface Props {
  packages: PackageDescription[];
  /** 지금 보는 파일 — 이름 옆에 「← 보는 중」 */
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
      {/* 여러 개를 한 번에 — 시험 잔재를 하나씩 지우던 손이 지쳤다(사용자 2026-09-09) */}
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
              // 「보는 중」 표시는 CSS ::after가 그린다 — 글자는 번역기를 거쳐 속성으로 넘긴다(CSS에 한국어를 적으면 영어 화면에 남는다)
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
