/**
 * Subscriptions — where events are pushed (webhook URL or MQTT broker), which types, which files.
 *
 * Important: the signing secret is shown **once** — in the create and rotate responses. The server never returns it
 *    again (listings carry only the last 4 characters). The box says so, because closing it loses the secret.
 * Important: a 422 `TargetNotAllowed` is the egress policy (private address, plain http, blocked port). The server's
 *    reason is shown as is, with the setting that opens it — an admin cannot guess "AAS_INTEGRATION_ALLOW" otherwise.
 */
import { DELIVERABLE_TYPES, eventClassOf, shortEventType } from '@aas/core';
import { useEffect, useState } from 'react';
import type { PackageDescription } from '../../api.js';
import { IntegrationError, integrationApi, type SubscriptionInput, type SubscriptionView, type TestResult } from '../../api/integration.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';
import { CopyBox, ErrorNote, packageLabel, splitList, when } from './common.js';
import { DeliveriesPanel } from './DeliveriesPanel.js';

interface Props {
  packages: readonly PackageDescription[];
}

interface Secret {
  name: string;
  secret: string;
  previousValidUntil?: string;
}

const GROUPS = [
  { kind: 'model', label: () => tr('모델 변경') },
  { kind: 'projection', label: () => tr('마스터 데이터 (설비 · BOM · 보전 · 문서)') },
  { kind: 'runtime', label: () => tr('가동 (상태 · 알람 · 계수 · 한계 · 연결)') },
] as const;

export function SubscriptionsTab({ packages }: Props): React.JSX.Element {
  const [items, setItems] = useState<SubscriptionView[]>();
  const [error, setError] = useState<unknown>();
  const [editing, setEditing] = useState<SubscriptionView | 'new'>();
  const [secret, setSecret] = useState<Secret>();
  const [tested, setTested] = useState<{ id: string; result: TestResult }>();
  const [deliveriesFor, setDeliveriesFor] = useState<SubscriptionView>();
  const [working, setWorking] = useState(false);

  const reload = async (): Promise<void> => {
    try {
      setItems((await integrationApi.subscriptions()).items);
    } catch (caught) {
      setError(caught);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  /** One action at a time; failures land in the error note */
  const act = async (work: () => Promise<void>): Promise<boolean> => {
    setError(undefined);
    setWorking(true);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setWorking(false);
    }
  };

  const save = async (input: SubscriptionInput): Promise<void> => {
    const ok = await act(async () => {
      if (editing === 'new') {
        const made = await integrationApi.createSubscription(input);
        setSecret({ name: made.subscription.name, secret: made.secret });
      } else if (editing) {
        await integrationApi.updateSubscription(editing.id, input);
      }
    });
    if (ok) {
      setEditing(undefined);
      await reload();
    }
  };

  if (deliveriesFor) return <DeliveriesPanel subscription={deliveriesFor} onBack={() => setDeliveriesFor(undefined)} />;

  return (
    <div className="integration-tab">
      <ErrorNote error={error} />
      {error instanceof IntegrationError && error.code === 'TargetNotAllowed' && (
        <p className="hint">
          <T k={'사설망 주소(10.x · 192.168.x 등)와 암호화 없는 http · mqtt 대상은 서버 설정 <code>AAS_INTEGRATION_ALLOW</code> 에 적힌 곳만 허용됩니다.'} />
        </p>
      )}

      {secret && (
        <section className="secret-once" role="status">
          <h3>{fill(tr('「{0}」 서명 비밀값'), { 0: secret.name })}</h3>
          <p className="note warning">{tr('지금 한 번만 보여 줍니다. 받는 쪽(MES · ERP)에 옮겨 적은 뒤 닫으십시오 — 다시 볼 수 없고, 잃어버리면 새로 바꿔야 합니다.')}</p>
          <CopyBox value={secret.secret} label={tr('서명 비밀값')} />
          {secret.previousValidUntil && (
            <p className="hint">{fill(tr('이전 비밀값도 {0}까지는 함께 서명됩니다 — 그 사이에 받는 쪽을 바꾸면 됩니다.'), { 0: when(secret.previousValidUntil) })}</p>
          )}
          <button type="button" onClick={() => setSecret(undefined)}>
            {tr('옮겨 적었습니다 — 닫기')}
          </button>
        </section>
      )}

      {editing ? (
        <SubscriptionForm
          initial={editing === 'new' ? undefined : editing}
          packages={packages}
          working={working}
          onSave={(input) => void save(input)}
          onCancel={() => setEditing(undefined)}
        />
      ) : (
        <div className="row-buttons">
          <button type="button" className="primary" onClick={() => setEditing('new')}>
            {tr('구독 추가')}
          </button>
        </div>
      )}

      {items && items.length === 0 && <p className="hint">{tr('아직 구독이 없습니다. MES · ERP 가 사건을 받을 주소를 더하십시오.')}</p>}
      {items && items.length > 0 && (
        <div className="table-scroll">
          <table className="integration-table">
            <thead>
              <tr>
                <th>{tr('이름')}</th>
                <th>{tr('방식')}</th>
                <th>{tr('주소')}</th>
                <th>{tr('받는 사건')}</th>
                <th>{tr('상태')}</th>
                <th>{tr('보낸 현황')}</th>
                <th>{tr('할 일')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <b>{item.name}</b>
                    <div className="dim mono">…{item.secretHint}</div>
                  </td>
                  <td>{item.kind === 'mqtt' ? 'MQTT' : tr('웹훅')}</td>
                  <td className="mono wrap">{item.url}</td>
                  <td className="mono wrap">{item.types.map(shortEventType).join(', ')}</td>
                  <td>
                    {item.enabled ? <span className="note ok">{tr('켜짐')}</span> : <span className="note warning">{tr('꺼짐')}</span>}
                    {item.disabledReason && <div className="dim">{item.disabledReason}</div>}
                  </td>
                  <td>
                    {item.stats
                      ? fill(tr('대기 {0} · 성공 {1} · 실패 {2}'), { 0: item.stats.pending + item.stats.inFlight, 1: item.stats.succeeded, 2: item.stats.dead })
                      : '—'}
                    <div className="dim">{fill(tr('마지막 성공 {0}'), { 0: when(item.lastSuccessAt) })}</div>
                    {tested?.id === item.id && <TestOutcome result={tested.result} />}
                  </td>
                  <td>
                    <div className="row-buttons wrap">
                      <button type="button" disabled={working} onClick={() => void act(async () => setTested({ id: item.id, result: await integrationApi.testSubscription(item.id) }))}>
                        {tr('시험 보내기')}
                      </button>
                      <button type="button" disabled={working} onClick={() => setDeliveriesFor(item)}>
                        {tr('보낸 기록')}
                      </button>
                      <button type="button" disabled={working} onClick={() => setEditing(item)}>
                        {tr('고치기')}
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() =>
                          void act(async () => {
                            const rotated = await integrationApi.rotateSecret(item.id);
                            setSecret({ name: item.name, secret: rotated.secret, ...(rotated.previousValidUntil ? { previousValidUntil: rotated.previousValidUntil } : {}) });
                          })
                        }
                      >
                        {tr('비밀값 바꾸기')}
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() =>
                          void act(async () => {
                            await integrationApi.updateSubscription(item.id, { enabled: !item.enabled });
                            await reload();
                          })
                        }
                      >
                        {item.enabled ? tr('끄기') : tr('켜기')}
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => {
                          if (!window.confirm(fill(tr('구독 「{0}」을(를) 지웁니다. 보낼 차례와 보낸 기록도 함께 지워집니다. 되돌릴 수 없습니다.'), { 0: item.name }))) return;
                          void act(async () => {
                            await integrationApi.deleteSubscription(item.id);
                            await reload();
                          });
                        }}
                      >
                        {tr('지우기')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TestOutcome({ result }: { result: TestResult }): React.JSX.Element {
  if (!result.ok) {
    return <p className="note error">{fill(tr('시험 실패 — {0}'), { 0: result.error ?? String(result.statusCode ?? '') })}</p>;
  }
  return (
    <div className="test-outcome">
      <p className="note ok">
        {fill(tr('시험 성공 — 응답 {0} · {1}ms · 주소 {2}'), { 0: result.statusCode ?? '—', 1: result.durationMs ?? '—', 2: result.address ?? '—' })}
      </p>
      {result.responseSnippet && <pre className="snippet">{result.responseSnippet}</pre>}
    </div>
  );
}

interface FormProps {
  initial: SubscriptionView | undefined;
  packages: readonly PackageDescription[];
  working: boolean;
  onSave: (input: SubscriptionInput) => void;
  onCancel: () => void;
}

/** Create / edit form. Types are a checklist of the catalogue plus free prefix filters such as `equipment.*` */
export function SubscriptionForm({ initial, packages, working, onSave, onCancel }: FormProps): React.JSX.Element {
  const catalogue = DELIVERABLE_TYPES as readonly string[];
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState(initial?.kind ?? 'webhook');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [types, setTypes] = useState<ReadonlySet<string>>(new Set(initial?.types.filter((type) => catalogue.includes(type)) ?? []));
  const [prefixes, setPrefixes] = useState((initial?.types ?? []).filter((type) => !catalogue.includes(type)).join(', '));
  const [packageIds, setPackageIds] = useState<ReadonlySet<string>>(new Set(initial?.packageIds ?? []));
  const [topicPrefix, setTopicPrefix] = useState(initial?.options.topicPrefix ?? '');
  const [retainState, setRetainState] = useState(initial?.options.retainState ?? false);
  const [problem, setProblem] = useState<string>();

  const toggle = (set: ReadonlySet<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const submit = (): void => {
    const chosen = [...types, ...splitList(prefixes)];
    if (name.trim() === '') return setProblem(tr('이름을 적으십시오.'));
    if (url.trim() === '') return setProblem(tr('주소를 적으십시오.'));
    // An empty list would mean "every type" in the core matcher — the API refuses it, so say why here first
    if (chosen.length === 0) return setProblem(tr('받을 사건을 하나 이상 고르십시오.'));
    setProblem(undefined);
    onSave({
      name: name.trim(),
      kind,
      url: url.trim(),
      types: chosen,
      packageIds: [...packageIds],
      ...(kind === 'mqtt' ? { options: { ...(topicPrefix.trim() ? { topicPrefix: topicPrefix.trim() } : {}), retainState } } : {}),
    });
  };

  return (
    <form
      className="integration-form"
      aria-label={initial ? tr('구독 고치기') : tr('구독 추가')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3>{initial ? fill(tr('구독 「{0}」 고치기'), { 0: initial.name }) : tr('새 구독')}</h3>
      <label>
        <span>{tr('이름')}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>{tr('방식')}</span>
        <select value={kind} onChange={(event) => setKind(event.target.value === 'mqtt' ? 'mqtt' : 'webhook')}>
          <option value="webhook">{tr('웹훅 (HTTPS POST)')}</option>
          <option value="mqtt">MQTT</option>
        </select>
      </label>
      <label>
        <span>{tr('주소')}</span>
        <input
          value={url}
          placeholder={kind === 'mqtt' ? 'mqtts://broker.plant.local:8883' : 'https://mes.plant.local/hooks/aas'}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      {kind === 'mqtt' && (
        <>
          <p className="hint">{tr('브로커 계정은 주소에 user:password@ 로 적으면 서버가 떼어 내 암호화해 보관합니다. MQTT 에는 서명이 없으니 mqtts 와 브로커 권한(ACL)으로 지키십시오.')}</p>
          <label>
            <span>{tr('토픽 앞부분')}</span>
            <input value={topicPrefix} placeholder="vexplor/aas/…" onChange={(event) => setTopicPrefix(event.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={retainState} onChange={(event) => setRetainState(event.target.checked)} />
            <span>{tr('설비 상태를 보존 메시지(retained)로도 올리기 — 나중에 붙는 쪽도 지금 상태를 바로 받습니다')}</span>
          </label>
        </>
      )}

      <fieldset>
        <legend>{tr('받을 사건')}</legend>
        {GROUPS.map((group) => (
          <div key={group.kind} className="type-group">
            <b>{group.label()}</b>
            {catalogue
              .filter((type) => eventClassOf(type) === group.kind)
              .map((type) => (
                <label key={type} className="check mono">
                  <input type="checkbox" checked={types.has(type)} onChange={() => setTypes(toggle(types, type))} />
                  <span>{shortEventType(type)}</span>
                </label>
              ))}
          </div>
        ))}
        <label>
          <span>{tr('앞부분으로 고르기 (쉼표로 나눔)')}</span>
          <input value={prefixes} placeholder="equipment.*" onChange={(event) => setPrefixes(event.target.value)} />
        </label>
      </fieldset>

      <fieldset>
        <legend>{tr('대상 파일 — 하나도 고르지 않으면 모든 파일')}</legend>
        {packages.map((item) => (
          <label key={item.packageId} className="check">
            <input type="checkbox" checked={packageIds.has(item.packageId)} onChange={() => setPackageIds(toggle(packageIds, item.packageId))} />
            <span>{packageLabel(item)}</span>
          </label>
        ))}
      </fieldset>

      {problem && (
        <p className="note error" role="alert">
          {problem}
        </p>
      )}
      <div className="row-buttons">
        <button type="submit" className="primary" disabled={working}>
          {initial ? tr('저장') : tr('만들기')}
        </button>
        <button type="button" onClick={onCancel}>
          {tr('그만두기')}
        </button>
      </div>
    </form>
  );
}
