/**
 * Remote collectors (VEXPLOR Edge) — the window where a factory PC is connected in one step and watched afterwards.
 *
 * What a person sees, in order:
 *  - the server has no edge (EDGE=off, demo, older server) → why, and nothing else
 *  - the edge is off and may be switched → admins get one button; others are told an admin can
 *  - on → "Connect a collector" (ConnectCard) and the list of collectors (DeviceRow), refreshed every 10 s
 *
 * Important: the panel only decides what is shown. The server decides what is allowed — a 403 is shown as is.
 * Important: the edge is a separate open-source program (github.com/waceinc/vexplor-edge). This panel connects it;
 *    the program itself is installed on the factory PC by the line ConnectCard makes.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuthState } from '../../api.js';
import { EDGE_REPOSITORY, edgeApi, edgeStatus, type EdgeDeviceView, type EdgeStatus } from '../../api/edge.js';
import { tr } from '../../i18n.js';
import { ErrorNote, integrationAccess } from '../integrations/common.js';
import { ConnectCard } from './ConnectCard.js';
import { DeviceRow } from './DeviceRow.js';

interface Props {
  auth: AuthState | undefined;
  onClose: () => void;
  onHelp?: () => void;
  /** Origin offered as the server address — the page's own unless a test passes one */
  origin?: string;
}

export function EdgePanel({ auth, onClose, onHelp, origin = globalThis.location?.origin ?? '' }: Props): React.JSX.Element {
  const access = integrationAccess(auth);
  const [status, setStatus] = useState<EdgeStatus | null>();
  const [devices, setDevices] = useState<EdgeDeviceView[]>([]);
  const [connecting, setConnecting] = useState<ReadonlySet<string>>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    edgeStatus()
      .then(async (next) => {
        setStatus(next ?? null);
        if (next?.enabled) setDevices(await edgeApi.devices());
      })
      .catch((caught: unknown) => setError(caught));
  }, []);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, [reload]);

  const switchOn = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await edgeApi.enable(true);
      reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const live = devices.filter((device) => !device.revokedAt);
  const revoked = devices.filter((device) => device.revokedAt);

  return (
    <div className="settings edge-panel">
      <h2>{tr('원격 수집기 (VEXPLOR Edge)')}</h2>
      <p className="hint">
        {tr('이 서버가 공장 밖(클라우드 · 본사)에 있을 때 씁니다. 공장 PC 한 대에 수집기를 두면 그 PC가 설비 값을 읽어 이 서버로 보냅니다 — 밖으로만 보내고, 공장으로 들어오는 연결은 없습니다.')}{' '}
        {onHelp && (
          <button type="button" className="link" onClick={onHelp}>
            {tr('자세히')}
          </button>
        )}
      </p>
      <ErrorNote error={error} />

      {status === undefined && <p className="dim">{tr('불러오는 중…')}</p>}

      {status === null && (
        <p className="note warning">{tr('이 서버에는 원격 수집기가 꺼져 있습니다 — 서버 설정 EDGE=off 이거나 체험 모드입니다. 서버 관리자가 EDGE 를 비우거나 on 으로 두고 다시 시작하면 여기서 연결할 수 있습니다.')}</p>
      )}

      {status && !status.enabled && (
        <section className="edge-off">
          <p>{tr('원격 수집이 꺼져 있습니다. 켜면 공장 PC를 이 서버에 연결할 수 있습니다.')}</p>
          {status.switchable && access.admin ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void switchOn()}>
              {tr('원격 수집 켜기')}
            </button>
          ) : (
            <p className="dim">{status.switchable ? tr('관리자 계정으로 로그인하면 여기서 켤 수 있습니다.') : tr('서버 설정 EDGE 가 정해 두었습니다.')}</p>
          )}
        </section>
      )}

      {status?.enabled && (
        <>
          {connecting ? (
            <ConnectCard
              status={status}
              origin={origin}
              knownIds={connecting}
              devices={devices}
              onReload={reload}
              onClose={() => {
                setConnecting(undefined);
                reload();
              }}
            />
          ) : (
            access.edit && (
              <div className="edge-cta">
                <button type="button" className="primary big" onClick={() => setConnecting(new Set(devices.map((device) => device.deviceId)))}>
                  {tr('+ 수집기 연결')}
                </button>
                <span className="dim small">{tr('단추를 누르고, 나온 한 줄을 공장 PC에 붙여 넣으면 끝입니다.')}</span>
              </div>
            )
          )}

          <section>
            <h3>{tr('연결된 수집기')}</h3>
            {live.length === 0 ? (
              <p className="dim">{tr('아직 연결된 수집기가 없습니다.')}</p>
            ) : (
              <ul className="edge-devices">
                {live.map((device) => (
                  <DeviceRow key={device.deviceId} device={device} canEdit={access.edit} onChanged={reload} />
                ))}
              </ul>
            )}
            {revoked.length > 0 && (
              <details className="edge-revoked">
                <summary>{tr('해지한 수집기')}</summary>
                <ul className="edge-devices">
                  {revoked.map((device) => (
                    <DeviceRow key={device.deviceId} device={device} canEdit={false} onChanged={reload} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        </>
      )}

      <p className="dim small">
        {tr('수집기는 별도 오픈소스 프로그램입니다(Apache-2.0):')}{' '}
        <a href={EDGE_REPOSITORY} target="_blank" rel="noreferrer">
          github.com/waceinc/vexplor-edge
        </a>
      </p>
      <div className="row-buttons actions">
        <button type="button" onClick={onClose}>
          {tr('닫기')}
        </button>
      </div>
    </div>
  );
}
