/**
 * One connected collector: how it is doing, when it last sent, and the few things a person does with it —
 * approve (after looking at the list), pause, resume, revoke.
 *
 * Important: approve always shows the list first and sends the revision that was shown. A list that changed in
 *    between is refused by the server (409) — the row reloads the preview instead of retrying.
 * Important: revoke cannot be undone (the device must be connected again with a new command), so it asks once.
 * Important: the OK · Attention · Problem badge and its first reason come from the server (2.8.0, edge/health.ts); the
 *    row only shows them. The numbers behind them open below the row (EdgeHealthDetails).
 */
import { useState } from 'react';
import { edgeApi, healthLabel, healthOf, type EdgeDeviceView, type EdgePreview } from '../../api/edge.js';
import { fill, tr } from '../../i18n.js';
import { ErrorNote, when } from '../integrations/common.js';
import { EdgeHealthDetails, VerdictBadge } from './EdgeHealthDetails.js';

export function HealthBadge({ device }: { device: EdgeDeviceView }): React.JSX.Element {
  const health = healthOf(device);
  return <span className={`edge-badge edge-${health}`}>{healthLabel(health)}</span>;
}

interface Props {
  device: EdgeDeviceView;
  canEdit: boolean;
  onChanged: () => void;
}

export function DeviceRow({ device, canEdit, onChanged }: Props): React.JSX.Element {
  const [preview, setPreview] = useState<EdgePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [open, setOpen] = useState(false);
  const health = healthOf(device);
  const verdict = device.health ?? undefined;
  const firstReason = verdict?.reasons[0];
  const links = device.lastStatus?.interfaces ?? [];
  const connected = links.filter((link) => link.connected).length;
  const failing = links.find((link) => !link.connected && link.lastError);

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      setPreview(undefined);
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const openPreview = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await edgeApi.preview(device.deviceId));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="edge-device">
      <div className="edge-device-head">
        <b>{device.hostname ?? device.name}</b> <HealthBadge device={device} />
        {verdict && <VerdictBadge verdict={verdict} />}
        {/* The version it runs now (each batch reports it) — the one recorded at registration goes stale after an upgrade */}
        <span className="dim small">
          {(device.lastStatus?.software ?? device.software).name} {(device.lastStatus?.software ?? device.software).version}
        </span>
      </div>
      <div className="edge-device-facts dim small">
        <span>{fill(tr('마지막 수신 {0}'), { 0: device.lastSeenAt ? when(device.lastSeenAt) : '—' })}</span>
        <span>{fill(tr('받은 값 {0}개'), { 0: device.samplesReceived.toLocaleString() })}</span>
        <span>{fill(tr('읽는 태그 {0}개'), { 0: String(device.tags) })}</span>
        {links.length > 0 && <span>{fill(tr('설비 연결 {0}/{1}'), { 0: String(connected), 1: String(links.length) })}</span>}
        {(device.lastStatus?.queuedBatches ?? 0) > 0 && <span>{fill(tr('보내지 못하고 쌓인 묶음 {0}개'), { 0: String(device.lastStatus?.queuedBatches) })}</span>}
      </div>
      {firstReason && (
        <p className={`edge-first-reason small edge-reason-${firstReason.level}`}>
          {firstReason.message}
          {verdict!.reasons.length > 1 && <span className="dim">{' '}{fill(tr('(이유 {0}개 더)'), { 0: String(verdict!.reasons.length - 1) })}</span>}
        </p>
      )}
      {failing && <p className="note warning small">{fill(tr('설비 연결 오류: {0}'), { 0: failing.lastError ?? '' })}</p>}
      {/* A server older than 2.8.0 sends no verdict — then this note is the only word on silence */}
      {health === 'silent' && !verdict && <p className="note warning small">{tr('3분 넘게 소식이 없습니다 — 공장 PC가 켜져 있는지, 서버로 나가는 길(443 · 프록시)이 열려 있는지 확인하십시오.')}</p>}
      {device.lastSeenAt && !device.revokedAt && (
        <button type="button" className="link edge-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? tr('상태 접기') : tr('상태 자세히')}
        </button>
      )}
      {open && <EdgeHealthDetails device={device} />}
      {device.changedSinceApproval && !device.revokedAt && (
        <p className="note warning small">{tr('승인한 뒤 파일이 바뀌었습니다 — 새 목록을 읽게 하려면 다시 승인하십시오.')}</p>
      )}

      {preview && (
        <div className="edge-preview">
          <p>{fill(tr('승인하면 이 수집기가 설비 {0}곳을 읽습니다:'), { 0: String(preview.interfaces.length) })}</p>
          <ul className="edge-items">
            {preview.interfaces.map((iface) => (
              <li key={iface.interfaceId}>
                <span>{iface.interfaceName}</span> <span className="dim">{iface.protocol}</span> <span className="dim mono">{iface.endpoint}</span>{' '}
                <span className="dim">{fill(tr('태그 {0}개'), { 0: String(iface.tags.length) })}</span>
              </li>
            ))}
          </ul>
          <div className="row-buttons">
            <button type="button" className="primary" disabled={busy || preview.interfaces.length === 0} onClick={() => void act(() => edgeApi.approve(device.deviceId, preview.revision))}>
              {tr('이 목록으로 승인')}
            </button>
            <button type="button" onClick={() => setPreview(undefined)}>
              {tr('취소')}
            </button>
          </div>
        </div>
      )}

      <ErrorNote error={error} />
      {canEdit && !device.revokedAt && !preview && (
        <div className="row-buttons edge-actions">
          {(device.state === 'pending-approval' || device.changedSinceApproval) && (
            <button type="button" className="primary" disabled={busy} onClick={() => void openPreview()}>
              {device.state === 'pending-approval' ? tr('목록 보고 승인') : tr('다시 승인')}
            </button>
          )}
          {device.state === 'approved' && (
            <button type="button" disabled={busy} onClick={() => void act(() => edgeApi.pause(device.deviceId))}>
              {tr('일시 정지')}
            </button>
          )}
          {device.state === 'paused' && device.approvedRevision && (
            <button type="button" disabled={busy} onClick={() => void act(() => edgeApi.resume(device.deviceId))}>
              {tr('다시 시작')}
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              if (globalThis.confirm(tr('이 수집기를 해지합니다. 되돌릴 수 없고, 다시 쓰려면 새 명령으로 연결해야 합니다.'))) void act(() => edgeApi.revoke(device.deviceId));
            }}
          >
            {tr('해지')}
          </button>
        </div>
      )}
    </li>
  );
}
