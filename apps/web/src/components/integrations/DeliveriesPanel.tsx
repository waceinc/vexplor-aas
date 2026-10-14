/**
 * Deliveries of one subscription — what was sent, what is waiting, what failed for good (dead letters).
 *
 * Important: "send again" puts a dead delivery back in the queue with the **same event id** — the receiver dedupes
 *    on it, so a resend never doubles a record on the MES side. Replay from a sequence number re-queues every
 *    matching event from that point (the receiver dedupes those too).
 */
import { shortEventType } from '@aas/core';
import { useEffect, useState } from 'react';
import { explainConflict, integrationApi, type DeliveryStatus, type DeliveryView, type SubscriptionView } from '../../api/integration.js';
import { fill, tr } from '../../i18n.js';
import { ErrorNote, when } from './common.js';

interface Props {
  subscription: SubscriptionView;
  onBack: () => void;
}

const STATUSES: readonly DeliveryStatus[] = ['pending', 'in-flight', 'succeeded', 'dead'];

function statusLabel(status: DeliveryStatus): string {
  if (status === 'pending') return tr('대기');
  if (status === 'in-flight') return tr('보내는 중');
  if (status === 'succeeded') return tr('성공');
  return tr('끝내 실패');
}

export function DeliveriesPanel({ subscription, onBack }: Props): React.JSX.Element {
  const [filter, setFilter] = useState<DeliveryStatus>();
  const [items, setItems] = useState<DeliveryView[]>();
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [fromSeq, setFromSeq] = useState('');

  const load = async (more: boolean): Promise<void> => {
    setError(undefined);
    try {
      const page = await integrationApi.deliveries(subscription.id, { ...(filter ? { status: filter } : {}), limit: 100, ...(more && cursor ? { cursor } : {}) });
      setItems((current) => (more ? [...(current ?? []), ...page.items] : page.items));
      setCursor(page.cursor);
    } catch (caught) {
      setError(caught);
    }
  };
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on filter change only; load is recreated every render to read the latest cursor
  }, [filter, subscription.id]);

  const redeliver = async (delivery: DeliveryView): Promise<void> => {
    setError(undefined);
    try {
      const next = await integrationApi.redeliver(delivery.id);
      setItems((current) => current?.map((item) => (item.id === delivery.id ? { ...item, ...next } : item)));
      setNotice(fill(tr('{0}번 사건을 다시 보낼 차례에 넣었습니다.'), { 0: String(delivery.eventSeq) }));
    } catch (caught) {
      setError(explainConflict(caught, tr('지금 보내는 중인 건은 다시 보낼 차례에 넣을 수 없습니다 — 이번 시도가 끝난 뒤 다시 하십시오.')));
    }
  };

  const replay = async (): Promise<void> => {
    setError(undefined);
    try {
      const result = await integrationApi.replay(subscription.id, { fromSeq: fromSeq.trim() });
      setNotice(fill(tr('{0}건을 다시 보낼 차례에 넣었습니다.'), { 0: result.enqueued }));
      await load(false);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <div className="integration-tab">
      <div className="row-buttons">
        <button type="button" onClick={onBack}>
          {tr('← 구독 목록')}
        </button>
        <h3>{fill(tr('「{0}」 보낸 기록'), { 0: subscription.name })}</h3>
      </div>
      <ErrorNote error={error} />
      {notice && <p className="note ok">{notice}</p>}

      <div className="row-buttons wrap">
        <label className="integration-picker">
          <span>{tr('상태')}</span>
          <select aria-label={tr('상태로 거르기')} value={filter ?? ''} onChange={(event) => setFilter((event.target.value || undefined) as DeliveryStatus | undefined)}>
            <option value="">{tr('모두')}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="integration-picker">
          <span>{tr('다시 보낼 시작 번호')}</span>
          <input inputMode="numeric" value={fromSeq} onChange={(event) => setFromSeq(event.target.value)} />
        </label>
        <button type="button" disabled={!/^\d+$/.test(fromSeq.trim())} onClick={() => void replay()}>
          {tr('그 번호부터 모두 다시 보내기')}
        </button>
      </div>

      {items && items.length === 0 && <p className="hint">{tr('기록이 없습니다.')}</p>}
      {items && items.length > 0 && (
        <div className="table-scroll">
          <table className="integration-table">
            <thead>
              <tr>
                <th>{tr('번호')}</th>
                <th>{tr('사건')}</th>
                <th>{tr('상태')}</th>
                <th>{tr('시도')}</th>
                <th>{tr('다음 시도')}</th>
                <th>{tr('마지막 결과')}</th>
                <th>{tr('보낸 주소')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={item.status === 'dead' ? 'dead' : ''}>
                  <td className="mono">{String(item.eventSeq)}</td>
                  <td className="mono">{item.type ? shortEventType(item.type) : item.eventId}</td>
                  <td>{statusLabel(item.status)}</td>
                  <td>{item.attempts}</td>
                  <td>{item.status === 'pending' ? when(item.nextAttemptAt) : '—'}</td>
                  <td className="wrap">
                    {item.lastStatusCode !== undefined ? `${item.lastStatusCode} ` : ''}
                    {item.lastError ?? ''}
                    {item.lastDurationMs !== undefined ? <span className="dim"> · {item.lastDurationMs}ms</span> : null}
                  </td>
                  <td className="mono">{item.lastAddress ?? '—'}</td>
                  <td>
                    {(item.status === 'dead' || item.status === 'succeeded') && (
                      <button type="button" onClick={() => void redeliver(item)}>
                        {tr('다시 보내기')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button type="button" onClick={() => void load(true)}>
          {tr('더 보기')}
        </button>
      )}
    </div>
  );
}
