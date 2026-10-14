/**
 * Integrations — the window where MES / ERP / CMMS connections are set up (design §9).
 *
 * Who sees what:
 *  - admins: everything — status, subscriptions and deliveries, exports, readiness, rules, external numbers, OPC UA certificates
 *  - editors: the feed address, exports, readiness, per-file rules and external numbers (server rules read-only)
 *  - viewers and read-only keys: the feed address, exports and readiness
 *
 * Important: tabs are plain buttons with tab roles, not the kit's Radix Tabs. Radix switches on pointer-down, which the
 *    rest of this screen's tests (and keyboard users pressing Enter) do not send; a button switches on click.
 */
import { useState } from 'react';
import type { AuthState, PackageDescription } from '../../api.js';
import { feedUrl } from '../../api/integration.js';
import { tr } from '../../i18n.js';
import { integrationAccess } from './common.js';
import { ExportsTab } from './ExportsTab.js';
import { ExternalRefsTab } from './ExternalRefsTab.js';
import { OpcuaCertsTab } from './OpcuaCertsTab.js';
import { ReadinessTab } from './ReadinessTab.js';
import { RulesTab } from './RulesTab.js';
import { StatusTab } from './StatusTab.js';
import { SubscriptionsTab } from './SubscriptionsTab.js';

export type IntegrationTab = 'status' | 'subscriptions' | 'exports' | 'readiness' | 'rules' | 'refs' | 'opcua';

interface Props {
  auth: AuthState | undefined;
  packages: readonly PackageDescription[];
  onClose: () => void;
  /** Origin used in copyable addresses — the page's own origin unless a test passes one */
  origin?: string;
}

function tabLabel(tab: IntegrationTab): string {
  if (tab === 'status') return tr('상태');
  if (tab === 'subscriptions') return tr('보내기 구독');
  if (tab === 'exports') return tr('내보내기');
  if (tab === 'readiness') return tr('준비 점검');
  if (tab === 'rules') return tr('판정 규칙');
  if (tab === 'refs') return tr('외부 번호');
  return tr('OPC UA 인증서');
}

export function visibleTabs(auth: AuthState | undefined): IntegrationTab[] {
  const access = integrationAccess(auth);
  if (access.admin) return ['status', 'subscriptions', 'exports', 'readiness', 'rules', 'refs', 'opcua'];
  if (access.edit) return ['status', 'exports', 'readiness', 'rules', 'refs'];
  return ['status', 'exports', 'readiness'];
}

export function Integrations({ auth, packages, onClose, origin = globalThis.location?.origin ?? '' }: Props): React.JSX.Element {
  const access = integrationAccess(auth);
  const tabs = visibleTabs(auth);
  const [tab, setTab] = useState<IntegrationTab>(tabs[0] ?? 'status');

  return (
    <div className="settings integrations">
      <h2>{tr('연동 (MES · ERP · CMMS)')}</h2>
      {!access.admin && (
        <p className="hint">
          {auth?.user
            ? tr('보내기 구독과 서버 설정은 관리자만 봅니다. 여기서는 읽어 가는 주소와 내보내기를 쓸 수 있습니다.')
            : tr('보내기 구독은 관리자 로그인에서만 만들 수 있습니다 — 설정 → 첫 관리자 만들기로 계정을 먼저 만드십시오.')}
        </p>
      )}
      <div className="integration-tabs" role="tablist" aria-label={tr('연동 화면')}>
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`integration-tab-${item}`}
            aria-selected={tab === item}
            aria-controls="integration-panel"
            className={tab === item ? 'active' : ''}
            onClick={() => setTab(item)}
          >
            {tabLabel(item)}
          </button>
        ))}
      </div>
      <div id="integration-panel" role="tabpanel" aria-labelledby={`integration-tab-${tab}`}>
        {tab === 'status' && <StatusTab admin={access.admin} feed={feedUrl(origin)} />}
        {tab === 'subscriptions' && <SubscriptionsTab packages={packages} />}
        {tab === 'exports' && <ExportsTab packages={packages} origin={origin} />}
        {tab === 'readiness' && <ReadinessTab packages={packages} />}
        {tab === 'rules' && <RulesTab admin={access.admin} edit={access.edit} packages={packages} />}
        {tab === 'refs' && <ExternalRefsTab edit={access.edit} packages={packages} />}
        {tab === 'opcua' && <OpcuaCertsTab />}
      </div>
      <div className="row-buttons actions">
        <button type="button" onClick={onClose}>
          {tr('닫기')}
        </button>
      </div>
    </div>
  );
}
