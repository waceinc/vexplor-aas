/**
 * Connect a collector — the one-click flow. The person checks the server address and the list, presses one button,
 * and gets one line to paste on the factory PC. That line installs, registers and (with "approve now") starts reading.
 *
 * Important: "approve now" approves the list shown here, at this revision — the same approval as the device list's
 *    "approve" button, made before the device exists. If the files change before the button is pressed, the server
 *    refuses (409) and the card reloads the list.
 * Important: after the command is made the card watches the device list every 3 s and shows the new device the moment
 *    it registers — the person does not have to come back and look.
 * Important: one code, two commands — Linux and Windows tabs show the same server and code; whichever is pasted first
 *    uses the code. Windows needs VEXPLOR Edge 1.2.0 (its first Windows package), and the tab says so.
 */
import { useEffect, useState } from 'react';
import { EDGE_WINDOWS_FROM, edgeApi, installCommand, installCommandWindows, unsafeForCommand, type EdgeCode, type EdgeDeviceView, type EdgeOs, type EdgeStatus } from '../../api/edge.js';
import { fill, tr } from '../../i18n.js';
import { ErrorNote, when } from '../integrations/common.js';
import { HealthBadge } from './DeviceRow.js';

/** The command shown whole (it wraps instead of scrolling inside a field) with one big copy button */
function CommandBox({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="edge-command">
      {/* Each word stays whole — a browser would otherwise break after the hyphen of `--server`. A word too long for a
          narrow window (the Windows line's TLS setting) may break anywhere instead of running out of the box */}
      <code aria-label={tr('설치 명령')}>
        {command.split(' ').map((word, index) => (
          <span key={index}>
            {index > 0 ? ' ' : ''}
            <span className={word.length > 40 ? 'edge-word-long' : 'edge-word'}>{word}</span>
          </span>
        ))}
      </code>
      <button
        type="button"
        className="primary"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? tr('복사했습니다') : tr('명령 복사')}
      </button>
    </div>
  );
}

interface Props {
  status: EdgeStatus;
  origin: string;
  /** Devices already known when the card opened — a device not in this set is the one just connected */
  knownIds: ReadonlySet<string>;
  devices: readonly EdgeDeviceView[];
  onReload: () => void;
  onClose: () => void;
}

export function ConnectCard({ status, origin, knownIds, devices, onReload, onClose }: Props): React.JSX.Element {
  const [server, setServer] = useState(origin);
  const [proxy, setProxy] = useState('');
  const [showProxy, setShowProxy] = useState(false);
  const [approveNow, setApproveNow] = useState(status.current.tags > 0);
  const [made, setMade] = useState<EdgeCode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [os, setOs] = useState<EdgeOs>('linux');

  // While waiting for the factory PC: read the device list every 3 s
  useEffect(() => {
    if (!made) return;
    const timer = setInterval(onReload, 3000);
    return () => clearInterval(timer);
  }, [made, onReload]);

  const fresh = made ? devices.find((device) => !knownIds.has(device.deviceId)) : undefined;
  const badServer = !/^https?:\/\/[^\s]+$/.test(server) || unsafeForCommand(server);
  const badProxy = proxy !== '' && (!/^https?:\/\/[^\s]+$/.test(proxy) || unsafeForCommand(proxy));
  // A factory PC cannot reach this machine's own loopback — say so before the command goes out with it
  const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(server);
  // The collector talks to its server over HTTPS only (plain http is allowed to this machine itself, for a test)
  const plainHttp = !badServer && !loopback && server.toLowerCase().startsWith('http://');

  const make = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setMade(await edgeApi.createCode(approveNow ? status.current.revision : undefined));
    } catch (caught) {
      setError(caught);
      onReload();
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    const address = server.replace(/\/+$/, '');
    const command = os === 'windows' ? installCommandWindows(address, made.code, proxy || undefined) : installCommand(address, made.code, proxy || undefined);
    return (
      <section className="edge-connect">
        <h3>{tr('공장 PC에 이 한 줄을 붙여 넣으십시오')}</h3>
        <div className="edge-os-tabs" role="tablist" aria-label={tr('공장 PC의 운영체제')}>
          {(['linux', 'windows'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`edge-os-${item}`}
              aria-selected={os === item}
              aria-controls="edge-os-panel"
              className={os === item ? 'active' : ''}
              onClick={() => setOs(item)}
            >
              {item === 'windows' ? 'Windows' : 'Linux'}
            </button>
          ))}
        </div>
        <div id="edge-os-panel" role="tabpanel" aria-labelledby={`edge-os-${os}`} className="edge-os-panel">
          {os === 'windows' ? (
            <>
              <p className="hint">
                {tr('Windows PC(x64)에서 명령 프롬프트나 PowerShell 을 「관리자 권한으로 실행」으로 열고 붙여 넣으면 설치 · 등록 · 서비스 시작까지 한 번에 끝납니다. 실행 정책은 바꾸지 않습니다.')}
              </p>
              <p className="note">{fill(tr('VEXPLOR Edge {0} 부터 — 그 판이 나오기 전에는 이 명령이 동작하지 않습니다.'), { 0: EDGE_WINDOWS_FROM })}</p>
            </>
          ) : (
            <p className="hint">{tr('Linux PC(x64 · arm64)의 터미널에 붙여 넣으면 설치 · 등록 · 시작까지 한 번에 끝납니다. 관리자 비밀번호(sudo)를 한 번 묻습니다.')}</p>
          )}
          {/* A new box per tab, so "Copied" never stands next to the command that was not copied */}
          <CommandBox key={os} command={command} />
        </div>
        <p className="dim small">
          {fill(tr('{0}까지 한 번만 쓸 수 있는 명령입니다.'), { 0: when(made.expiresAt) })}{' '}
          {made.preapproved
            ? fill(tr('설비 {0}곳 · 태그 {1}개를 바로 읽도록 승인해 두었습니다.'), { 0: String(made.preapproved.interfaces), 1: String(made.preapproved.tags) })
            : tr('연결된 뒤 이 화면에서 읽을 목록을 승인해야 값이 들어옵니다.')}
        </p>
        {fresh ? (
          <div className="edge-arrived" role="status">
            <p>
              <b>{fill(tr('연결되었습니다 — {0}'), { 0: fresh.hostname ?? fresh.name })}</b> <HealthBadge device={fresh} />
            </p>
            <p className="small">
              {fresh.state === 'approved'
                ? tr('값은 그 설비 파일을 열면 오른쪽 「수집」 칸에 저절로 들어옵니다. 이 창에서는 수집기 상태를 봅니다.')
                : tr('아래 「연결된 수집기」에서 「목록 보고 승인」을 누르면 값이 들어오기 시작합니다.')}
            </p>
          </div>
        ) : (
          <p className="note edge-waiting" role="status">
            <span className="edge-pulse" aria-hidden="true" /> {tr('공장 PC를 기다리는 중입니다 — 명령을 붙여 넣으면 여기에 저절로 나타납니다.')}
          </p>
        )}
        <div className="row-buttons">
          <button type="button" onClick={onClose}>
            {fresh ? tr('완료') : tr('닫기 — 나중에 목록에서 확인')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="edge-connect">
      <h3>{tr('수집기 연결')}</h3>
      <ol className="edge-steps">
        <li>{tr('아래를 확인하고 「연결 명령 만들기」를 누릅니다')}</li>
        <li>{tr('나온 한 줄을 공장 PC에 붙여 넣습니다')}</li>
        <li>{tr('이 화면에 「받는 중」이 뜨면 끝입니다')}</li>
      </ol>

      <label className="edge-field">
        <span>{tr('공장 PC가 찾아올 이 서버의 주소')}</span>
        <input value={server} onChange={(event) => setServer(event.target.value.trim())} aria-invalid={badServer} />
      </label>
      {badServer && <p className="note warning">{tr('http:// 또는 https:// 로 시작하는 주소를 넣으십시오(따옴표 · 공백 없이).')}</p>}
      {plainHttp && <p className="note warning">{tr('수집기는 https 주소로만 서버에 붙습니다 — https:// 로 시작하는 주소를 넣으십시오(서버 앞에 HTTPS 를 두는 법: 설치 안내의 Caddyfile).')}</p>}
      {!badServer && loopback && (
        <p className="note warning">{tr('지금 주소는 이 컴퓨터 자신을 가리킵니다 — 공장 PC는 이 주소로 찾아올 수 없습니다. 공장 PC가 닿는 도메인이나 IP 로 바꾸십시오.')}</p>
      )}
      {showProxy ? (
        <label className="edge-field">
          <span>{tr('공장 PC가 밖으로 나갈 때 쓰는 프록시(있을 때만)')}</span>
          <input value={proxy} placeholder="http://proxy.plant.local:3128" onChange={(event) => setProxy(event.target.value.trim())} aria-invalid={badProxy} />
        </label>
      ) : (
        <button type="button" className="link" onClick={() => setShowProxy(true)}>
          {tr('프록시를 거쳐야 하나요?')}
        </button>
      )}

      {status.current.tags > 0 ? (
        <div className="edge-list">
          <label className="edge-approve">
            <input type="checkbox" checked={approveNow} onChange={(event) => setApproveNow(event.target.checked)} />
            <span>
              <b>{fill(tr('이 목록을 바로 읽게 승인 — 설비 {0}곳 · 태그 {1}개'), { 0: String(status.current.interfaces), 1: String(status.current.tags) })}</b>
              <br />
              <span className="dim small">{tr('수집기는 승인한 목록만 읽습니다. 끄면 연결된 뒤 이 화면에서 따로 승인합니다.')}</span>
            </span>
          </label>
          <ul className="edge-items">
            {status.current.items.map((item) => (
              <li key={`${item.packageId}/${item.interfaceName}`}>
                <span>{item.interfaceName}</span> <span className="dim">{item.protocol}</span> <span className="dim">{fill(tr('태그 {0}개'), { 0: String(item.tags) })}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="note warning">{tr('읽을 태그가 아직 없습니다. 설비 파일에 수집 연결(AID)을 먼저 만들면 연결하자마자 값이 들어옵니다 — 파일을 연 뒤 오른쪽 「수집」의 「수집 연결 만들기」.')}</p>
      )}

      <ErrorNote error={error} />
      <div className="row-buttons">
        <button type="button" className="primary" disabled={busy || badServer || badProxy || plainHttp} onClick={() => void make()}>
          {tr('연결 명령 만들기')}
        </button>
        <button type="button" onClick={onClose}>
          {tr('취소')}
        </button>
      </div>
    </section>
  );
}
