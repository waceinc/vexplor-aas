/**
 * How a remote collector is doing, opened from its row (2.8.0): the factory PC, the line to the server, each piece of
 * equipment, and the last 24 hours.
 *
 * Important: the verdict (OK · Attention · Problem and its reasons) comes from the server (apps/api/src/edge/health.ts).
 *    This screen only shows numbers and never judges again — the guide and the screen must say the same thing.
 * Important: an edge older than 1.1.0 does not send the PC, line or per-equipment numbers. Those places say so
 *    ("not sent by this version") instead of showing 0 or a blank that reads like a fault.
 * Important: the trend is read only while the row is open — never with the 10-second list.
 */
import { useEffect, useState } from 'react';
import { edgeApi, verdictLabel, type EdgeDeviceView, type EdgeHistoryPoint, type EdgeVerdict } from '../../api/edge.js';
import { fill, tr } from '../../i18n.js';
import { ErrorNote, when } from '../integrations/common.js';
import { bytes, clockOffset, duration, millis, NONE, percent, ratio } from './format.js';
import { Trend } from './EdgeTrend.js';

export function VerdictBadge({ verdict }: { verdict: EdgeVerdict }): React.JSX.Element {
  return <span className={`edge-badge edge-verdict-${verdict.level}`}>{verdictLabel(verdict.level)}</span>;
}

const NOT_SENT = (): string => tr('이 판은 보내지 않음(1.1.0 이상)');

function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="edge-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function EdgeHealthDetails({ device }: { device: EdgeDeviceView }): React.JSX.Element {
  const status = device.lastStatus;
  const host = status?.host;
  const server = status?.server;
  const links = status?.interfaces ?? [];
  const software = status?.software ?? device.software;
  const newLinkFields = links.some((link) => link.responseMs !== undefined || link.readOkRatio !== undefined || link.reconnects !== undefined || link.lastDisconnectAt !== undefined);
  const [history, setHistory] = useState<EdgeHistoryPoint[]>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let live = true;
    edgeApi
      .history(device.deviceId)
      .then((items) => live && setHistory(items))
      .catch((caught: unknown) => live && setError(caught));
    return () => {
      live = false;
    };
  }, [device.deviceId, device.lastSeenAt]);

  return (
    <div className="edge-health" data-testid="edge-health">
      {device.health && device.health.reasons.length > 0 && (
        <ul className="edge-reasons">
          {device.health.reasons.map((reason) => (
            <li key={reason.code + (reason.interfaceId ?? '')} className={`edge-reason edge-reason-${reason.level}`}>
              <b>{verdictLabel(reason.level)}</b> {reason.message}
            </li>
          ))}
        </ul>
      )}

      <section>
        <h4>{tr('공장 PC')}</h4>
        <dl className="edge-facts">
          <Fact label={tr('수집기 판')} value={`${software.name} ${software.version}`} />
          {host ? (
            <>
              <Fact label={tr('CPU')} value={percent(host.cpuPercent)} />
              <Fact label={tr('메모리 사용')} value={percent(host.memoryUsedPercent)} />
              <Fact
                label={tr('디스크 남은 공간')}
                value={host.diskFreePercent === undefined ? NONE : `${bytes(host.diskFreeBytes)} (${percent(host.diskFreePercent)})`}
              />
              <Fact label={tr('PC 켜진 시간')} value={duration(host.uptimeSeconds)} />
              <Fact label={tr('수집기 실행 시간')} value={duration(host.processUptimeSeconds)} />
              <Fact label={tr('시계 오차')} value={clockOffset(host.clockOffsetMs)} />
            </>
          ) : (
            <Fact label={tr('CPU · 메모리 · 디스크 · 켜진 시간 · 시계 오차')} value={<span className="dim">{NOT_SENT()}</span>} />
          )}
        </dl>
      </section>

      <section>
        <h4>{tr('서버 통신')}</h4>
        <dl className="edge-facts">
          <Fact label={tr('밀린 묶음')} value={fill(tr('{0}개'), { 0: String(status?.queuedBatches ?? 0) })} />
          {host?.queuedInMemory !== undefined && host.queuedInMemory > 0 && <Fact label={tr('메모리에서 기다리는 묶음')} value={fill(tr('{0}개'), { 0: String(host.queuedInMemory) })} />}
          <Fact label={tr('버린 묶음')} value={fill(tr('{0}개'), { 0: String(status?.droppedBatches ?? 0) })} />
          {server ? (
            <>
              <Fact label={tr('마지막 성공')} value={when(server.lastSendOkAt)} />
              <Fact label={tr('왕복 시간')} value={millis(server.roundTripMs)} />
              <Fact label={tr('실패 수(마지막 성공 뒤)')} value={fill(tr('{0}번'), { 0: String(server.sendFailuresSinceOk ?? 0) })} />
              <Fact label={tr('가장 오래 밀린 묶음')} value={when(server.oldestQueuedAt)} />
              <Fact label={tr('마지막 실패')} value={server.lastSendError ? `${server.lastSendError} (${when(server.lastSendErrorAt)})` : NONE} />
              {host?.queueWriteError && <Fact label={tr('대기열 쓰기 실패')} value={`${host.queueWriteError} (${when(host.queueWriteErrorAt)})`} />}
            </>
          ) : (
            <Fact label={tr('마지막 성공 · 왕복 시간 · 실패 수 · 가장 오래 밀린 묶음')} value={<span className="dim">{NOT_SENT()}</span>} />
          )}
        </dl>
      </section>

      <section>
        <h4>{tr('설비별')}</h4>
        {links.length === 0 ? (
          <p className="dim small">{tr('아직 읽는 설비가 없습니다.')}</p>
        ) : (
          <div className="edge-table-wrap">
            <table className="edge-links">
              <thead>
                <tr>
                  <th>{tr('설비(인터페이스)')}</th>
                  <th>{tr('연결')}</th>
                  <th>{tr('응답 시간')}</th>
                  <th>{tr('성공률')}</th>
                  <th>{tr('재연결')}</th>
                  <th>{tr('마지막 끊김')}</th>
                  <th>{tr('마지막 오류')}</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.interfaceId}>
                    <td className="mono">{link.interfaceId}</td>
                    <td className={link.connected ? 'ok' : 'warn'}>{link.connected ? tr('연결됨') : tr('연결 끊김')}</td>
                    <td>{millis(link.responseMs)}</td>
                    <td>{ratio(link.readOkRatio)}</td>
                    <td>{link.reconnects === undefined ? NONE : fill(tr('{0}번'), { 0: String(link.reconnects) })}</td>
                    <td>{when(link.lastDisconnectAt)}</td>
                    <td className="edge-link-error">{link.lastError ?? NONE}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {links.length > 0 && !newLinkFields && <p className="dim small">{fill(tr('응답 시간 · 성공률 · 재연결 · 마지막 끊김: {0}'), { 0: NOT_SENT() })}</p>}
      </section>

      <section>
        <h4>{tr('최근 24시간 (5분마다)')}</h4>
        <ErrorNote error={error} />
        {history === undefined && !error ? <p className="dim small">{tr('불러오는 중…')}</p> : history && <Trend points={history} />}
      </section>
    </div>
  );
}
