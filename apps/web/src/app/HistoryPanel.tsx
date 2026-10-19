/**
 * Change history card — past versions of one submodel and "Restore this version".
 * Split out of App.tsx (componentization, 2026-10-13).
 */
import type { HistoryEntry } from '../api.js';
import { fill } from '../i18n.js';
import { localTime } from '../model.js';
import { PanelHead } from '../ui/PanelHead.js';

interface Props {
  t: (text: string) => string;
  label: string;
  entries: HistoryEntry[];
  busy: boolean;
  onRestore: (changedAt: string) => void;
  onClose: () => void;
}

export function HistoryPanel({ t, label, entries, busy, onRestore, onClose }: Props): React.JSX.Element {
  return (
    <div className="history-panel">
      <PanelHead title={<>{label} — {fill(t('변경 이력 {n}건'), { n: entries.length })}</>} onClose={onClose} closeText={t('닫기')} />
      {entries.length === 0 ? (
        <p className="hint">{t('아직 변경한 적이 없습니다 — 처음 만든 그대로입니다.')}</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.changedAt}>
              <span className="mono">{localTime(entry.changedAt)}</span>
              <span className="dim">
                {entry.operation === 'delete'
                  ? t('지워지기 전')
                  : fill(t('고치기 전 (요소 {n}개)'), { n: entry.elementCount })}
              </span>
              {/* "Who" — absent on servers without login and in old records. When absent it is not shown at all:
                  writing "no record" would line every row with filler and tire the eyes */}
              {entry.actorName && (
                <span className="who" title={entry.actorName}>
                  {entry.actorName}
                </span>
              )}
              <button
                className="link"
                disabled={busy}
                title={t('이 시점의 내용으로 되돌립니다 — 그 뒤에 고친 것은 사라집니다')}
                onClick={() => onRestore(entry.changedAt)}
              >
                {t('이 버전으로 되돌리기')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">{t('되돌리기 자체도 이력에 남습니다 — 되돌린 것을 또 되돌릴 수 있습니다.')}</p>
    </div>
  );
}
