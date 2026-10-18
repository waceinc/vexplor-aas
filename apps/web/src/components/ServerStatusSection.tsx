/**
 * The server's own state, in Settings, for admins (2.8.0): is the store answering, how much disk is left, what the
 * remote collectors sent in the last hour, which version runs.
 *
 * Important: shown only to an admin session — the server refuses everyone else (GET /server/status). A server older
 *    than 2.8.0 has no such route; then the section is not shown at all.
 */
import { useCallback, useEffect, useState } from 'react';
import { serverStatus, type ServerStatus } from '../api/server.js';
import { fill, tr } from '../i18n.js';
import { ErrorNote } from './integrations/common.js';
import { bytes, duration, percent } from './edge/format.js';

function storeName(kind: ServerStatus['store']['kind']): string {
  // i18n-ignore — a product name
  if (kind === 'postgres') return 'PostgreSQL';
  if (kind === 'folder') return tr('폴더');
  return tr('메모리(다시 시작하면 사라짐)');
}

export function ServerStatusSection(): React.JSX.Element | null {
  const [status, setStatus] = useState<ServerStatus | null>();
  const [error, setError] = useState<unknown>();
  const load = useCallback(() => {
    setError(undefined);
    serverStatus()
      .then((next) => setStatus(next ?? null))
      .catch((caught: unknown) => setError(caught));
  }, []);
  useEffect(load, [load]);

  if (status === null) return null;
  return (
    <section>
      <h3>{tr('서버 상태')}</h3>
      <ErrorNote error={error} />
      {status === undefined && !error && <p className="dim">{tr('불러오는 중…')}</p>}
      {status && (
        <dl className="server-status">
          <div className="edge-fact">
            <dt>{tr('서버 판')}</dt>
            <dd>{status.version}</dd>
          </div>
          <div className="edge-fact">
            <dt>{tr('실행 시간')}</dt>
            <dd>{duration(status.uptimeSeconds)}</dd>
          </div>
          <div className="edge-fact wide">
            <dt>{tr('저장소')}</dt>
            <dd className={status.store.ok ? 'ok' : 'fail'}>
              {status.store.ok
                ? fill(tr('{0} — 연결됨 ({1} ms)'), { 0: storeName(status.store.kind), 1: String(status.store.responseMs) })
                : fill(tr('{0} — 답이 없음: {1}'), { 0: storeName(status.store.kind), 1: status.store.error ?? '' })}
            </dd>
          </div>
          <div className="edge-fact">
            <dt>{status.disk?.of === 'data' ? tr('데이터 폴더 디스크 남은 공간') : tr('서버 디스크 남은 공간')}</dt>
            <dd>
              {status.disk
                ? `${bytes(status.disk.freeBytes)} / ${bytes(status.disk.totalBytes)} (${percent(status.disk.freePercent)})`
                : tr('이 서버에서 읽을 수 없음')}
              {status.store.kind === 'postgres' && <span className="dim small"> {tr('— 데이터베이스 디스크는 여기서 보이지 않습니다')}</span>}
            </dd>
          </div>
          {status.edge && (
            <div className="edge-fact wide">
              <dt>{status.edge.sinceStart ? tr('원격 수집기 — 서버가 시작한 뒤') : tr('원격 수집기 — 최근 1시간')}</dt>
              <dd>
                {fill(tr('받은 묶음 {0}개 · 거절한 요청 {1}개 · 저장하지 않은 값 {2}개'), {
                  0: String(status.edge.batches),
                  1: String(status.edge.refused),
                  2: String(status.edge.samplesRejected),
                })}
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="row-buttons">
        <button type="button" onClick={load}>
          {tr('다시 보기')}
        </button>
      </div>
    </section>
  );
}
