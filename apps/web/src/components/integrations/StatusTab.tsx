/**
 * Status — is integration running, and if not, which setting turns it on. Plus the pull-feed address an MES copies.
 *
 * Important: the pull feed works even when INTEGRATIONS is off (design D15 — events are always recorded). Saying
 *    "integration is off" without that would send people to restart the server when all they need is the feed.
 * Important: non-admins never call /integrations/status (it is admin-only and would answer 403) — they see the feed
 *    address only.
 */
import { useEffect, useState } from 'react';
import { integrationApi, type IntegrationStatusView } from '../../api/integration.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';
import { CopyBox, ErrorNote, when } from './common.js';

interface Props {
  admin: boolean;
  /** Absolute feed address (origin + /integrations/events?after=0) */
  feed: string;
}

function masterKeyText(source: IntegrationStatusView['masterKey']): string {
  if (source === 'env') return tr('환경 변수 AAS_SECRET_KEY');
  if (source === 'file') return tr('데이터 폴더의 secret.key 파일 — 데이터 폴더를 백업하면 이 키도 함께 복사됩니다');
  if (source === 'ephemeral') return tr('임시 키 — 서버를 다시 켜면 구독의 서명 비밀값을 다시 만들어야 합니다');
  if (source === 'missing') return tr('없음 — PostgreSQL 저장소에서는 AAS_SECRET_KEY 를 두어야 구독을 만들 수 있습니다');
  return '—';
}

function opcuaText(security: 'secure' | 'insecure' | 'off' | undefined): string {
  if (security === 'secure') return tr('보안 연결 — 계정 로그인과 서명·암호화가 필요합니다');
  if (security === 'insecure') return tr('보안 없음 — OPCUA_ALLOW_INSECURE=on 으로 켜져 있습니다. 공장망 밖에 열지 마십시오.');
  if (security === 'off') return tr('꺼짐');
  return '—';
}

export function StatusTab({ admin, feed }: Props): React.JSX.Element {
  const [status, setStatus] = useState<IntegrationStatusView>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    if (!admin) return;
    let alive = true;
    integrationApi
      .status()
      .then((next) => alive && setStatus(next))
      .catch((caught: unknown) => alive && setError(caught));
    return () => {
      alive = false;
    };
  }, [admin]);

  return (
    <div className="integration-tab">
      <section>
        <h3>{tr('읽어 가는 주소 (pull)')}</h3>
        <p className="hint">{tr('MES · ERP · CMMS 가 이 주소를 주기적으로 읽어 새 사건을 가져갑니다. 받은 마지막 번호(nextAfter)를 다음 요청의 after 로 넘기면 빠짐없이 받습니다. 연동 기능이 꺼져 있어도 이 주소는 동작합니다.')}</p>
        <CopyBox value={feed} label={tr('읽어 가는 주소')} />
      </section>

      {admin && <ErrorNote error={error} />}
      {admin && status && (
        <section>
          <h3>{tr('연동 상태')}</h3>
          {status.enabled ? (
            <p className="note ok">{tr('켜짐 — 상태 판정 · 마스터 데이터 알림 · 보내기(웹훅 · MQTT)가 돌고 있습니다.')}</p>
          ) : status.demo ? (
            <p className="note warning">{tr('체험 모드에서는 연동이 꺼져 있습니다.')}</p>
          ) : (
            <p className="note warning">
              <T k={'꺼짐 — 보내기와 상태 판정이 멈춰 있습니다. 켜려면 서버에 <code>INTEGRATIONS=on</code> 을 두고 다시 시작하십시오.'} />
              {status.reason ? ` (${status.reason})` : ''}
            </p>
          )}
          <dl className="integration-facts">
            <dt>{tr('서버 식별자')}</dt>
            <dd className="mono">{status.instanceId ?? '—'}</dd>
            <dt>{tr('보내기 작업')}</dt>
            <dd>
              {status.workers?.dispatcher
                ? fill(tr('{0} · 마지막 분배 {1} · 커서 {2}'), {
                    0: status.workers.dispatcher.running ? tr('도는 중') : tr('멈춤'),
                    1: when(status.workers.dispatcher.lastFanoutAt),
                    2: String(status.workers.dispatcher.cursor ?? '—'),
                  })
                : '—'}
            </dd>
            <dt>{tr('마스터 데이터 알림')}</dt>
            <dd>{status.workers?.projector ? (status.workers.projector.running ? tr('도는 중') : tr('멈춤')) : '—'}</dd>
            <dt>{tr('상태 판정')}</dt>
            <dd>
              {status.workers?.detector
                ? fill(tr('{0} · 마지막 판정 {1}'), { 0: status.workers.detector.enabled ? tr('도는 중') : tr('멈춤'), 1: when(status.workers.detector.lastCycleAt) })
                : '—'}
            </dd>
            <dt>{tr('보낼 차례 · 실패')}</dt>
            <dd>
              {status.backlog
                ? fill(tr('대기 {0}건 (가장 오래된 것 {1}) · 끝내 실패 {2}건'), { 0: status.backlog.pending, 1: when(status.backlog.oldestPendingAt), 2: status.backlog.dead })
                : '—'}
            </dd>
            <dt>{tr('비밀값 보관 키')}</dt>
            <dd className={status.masterKey === 'missing' || status.masterKey === 'ephemeral' ? 'warn' : ''}>{masterKeyText(status.masterKey)}</dd>
            <dt>{tr('허용한 내부 대상')}</dt>
            <dd className="mono">
              {status.egress && status.egress.allow.length > 0
                ? status.egress.allow.join(', ')
                : tr('없음 — 사설망 주소와 http · mqtt(암호화 없음) 대상은 막힙니다. AAS_INTEGRATION_ALLOW 로 엽니다.')}
            </dd>
            <dt>{tr('OPC UA 서버')}</dt>
            <dd>
              {opcuaText(status.opcua?.security)}
              {status.opcua?.pki ? <span className="dim mono"> · {status.opcua.pki}</span> : null}
            </dd>
          </dl>
        </section>
      )}
    </div>
  );
}
