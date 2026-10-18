/**
 * Create collection link — how to connect (2.8.0): OPC UA security mode and policy, a login for OPC UA and MQTT,
 * and how often to read this equipment.
 *
 * Important: **no password field.** The AID only says that a login is needed. The user name and password go into the
 *    server's credentials file and the factory PC's credentials.json under this address — a password typed here would
 *    be stored in the equipment file and handed to everyone who receives it.
 * Important: a user name or password already in the address (old MQTT links) is shown as a warning with one button to
 *    take it out — "Create" stays locked until then, the server refuses it too.
 */
import type { AidSecurityChoice } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';
import { hasUserInfo, maskedEndpoint, withoutUserInfo, type AidProtocolChoice } from './protocol.js';

/** Policies the collector connects with — the same list the server accepts (@aas/collector OPCUA_POLICIES) */
const POLICIES = ['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'] as const;

interface Props {
  protocol?: AidProtocolChoice;
  endpoint: string;
  setEndpoint: (endpoint: string) => void;
  security: AidSecurityChoice;
  setSecurity: (security: AidSecurityChoice) => void;
  /** Read period in seconds as typed — empty means the server default */
  periodText: string;
  setPeriodText: (text: string) => void;
}

/** The typed read period in ms, undefined when empty, or 'bad' when it is not 0.1 – 3600 seconds */
export function periodMs(text: string): number | undefined | 'bad' {
  if (text.trim() === '') return undefined;
  const seconds = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 3600) return 'bad';
  return Math.round(seconds * 1000);
}

export function AidConnection({ protocol, endpoint, setEndpoint, security, setSecurity, periodText, setPeriodText }: Props): React.JSX.Element | null {
  if (!protocol) return null;
  const mode = security.mode ?? 'None';
  const secret = hasUserInfo(endpoint);
  const badPeriod = periodMs(periodText) === 'bad';
  return (
    <div className="aid-connection">
      {secret && (
        <p className="note warn self-warn">
          <T k={'<b>주소에 사용자 이름 · 암호가 들어 있습니다</b> ({0}) — 이대로 만들면 설비 파일과 원격 수집기 목록에 암호가 실립니다.'} v={[<span className="mono">{maskedEndpoint(endpoint)}</span>]} />{' '}
          <button
            className="link"
            onClick={() => {
              setEndpoint(withoutUserInfo(endpoint));
              setSecurity({ ...security, login: true });
            }}
          >
            {tr('주소에서 떼고 로그인 필요 켜기')}
          </button>
        </p>
      )}
      <div className="aid-connection-line">
        {protocol === 'OPCUA' && (
          <>
            <label>
              {tr('보안 방식')}
              <select
                value={mode}
                aria-label={tr('보안 방식')}
                onChange={(event) => {
                  const next = event.target.value as 'None' | 'Sign' | 'SignAndEncrypt';
                  setSecurity({ ...security, mode: next, ...(next === 'None' ? { policy: undefined } : { policy: security.policy ?? POLICIES[0] }) });
                }}
              >
                <option value="None">{tr('None (암호화 없음)')}</option>
                <option value="Sign">Sign</option>
                <option value="SignAndEncrypt">SignAndEncrypt</option>
              </select>
            </label>
            <label>
              {tr('보안 정책')}
              <select
                value={mode === 'None' ? '' : (security.policy ?? POLICIES[0])}
                aria-label={tr('보안 정책')}
                disabled={mode === 'None'}
                onChange={(event) => setSecurity({ ...security, policy: event.target.value })}
              >
                {mode === 'None' && <option value="">—</option>}
                {POLICIES.map((policy) => (
                  <option key={policy} value={policy}>{policy}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {(protocol === 'OPCUA' || protocol === 'MQTT') && (
          <label className="check-line">
            <input type="checkbox" checked={security.login === true} onChange={(event) => setSecurity({ ...security, login: event.target.checked })} />
            {tr('로그인 필요')}
          </label>
        )}
        <label>
          {tr('읽기 주기(초)')}
          <input
            value={periodText}
            inputMode="decimal"
            className={badPeriod ? 'miss' : ''}
            aria-label={tr('읽기 주기(초)')}
            placeholder={tr('기본')}
            title={tr('이 설비를 몇 초마다 읽을지 — 비우면 서버 기본값(원격 수집기 5초, 서버 자동 수집은 COLLECT_INTERVAL). 0.1 ~ 3600초')}
            onChange={(event) => setPeriodText(event.target.value)}
          />
        </label>
      </div>
      {security.login && (
        <p className="hint">
          <T k={'사용자 이름 · 암호는 이 화면에 넣지 않습니다. 서버의 {0} 파일과 공장 PC 의 {1} 에 이 주소({2})로 적으십시오 — 설비 파일에는 「로그인이 필요하다」는 것만 남습니다.'} v={[<span className="mono">OPCUA_CLIENT_CREDENTIALS</span>, <span className="mono">credentials.json</span>, <span className="mono">{withoutUserInfo(endpoint)}</span>]} />
        </p>
      )}
      {mode !== 'None' && (
        <p className="hint">{tr('Sign · SignAndEncrypt 는 서버의 인증서 폴더(OPCUA_CLIENT_PKI_DIR)를 씁니다. 설비 인증서를 처음 볼 때는 거절되니, rejected 폴더의 인증서를 trusted/certs 로 옮기거나 OPCUA_CLIENT_TRUST=first-use 로 띄우십시오.')}</p>
      )}
      {badPeriod && <p className="hint warn">{fill(tr('읽기 주기는 {0} ~ {1}초 사이의 숫자로 적습니다.'), { 0: 0.1, 1: 3600 })}</p>}
    </div>
  );
}
