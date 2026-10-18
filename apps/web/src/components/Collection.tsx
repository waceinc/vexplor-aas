/**
 * Collection screen — spec M8.
 *
 * Shows two things in one place: **what can be collected** (AID) and **what came in last**.
 *
 * Important: the values shown here are **not the model.** Under value-sync option A, collected values only accumulate
 * in the time series and never go back to the file — so the screen keeps them apart from the tree and property panes to make that boundary visible.
 */
import { useEffect, useState } from 'react';
import type { AidInterfaceView, CollectedValueView, CycleReportView, LiveMapping } from '../api.js';
import { addressCsv, addressRows } from '../addressList.js';
import { localTime } from '../model.js';
import { tr } from '../i18n.js';
import { T } from './T.js';
import { download, type EquipmentRow } from './collection/helpers.js';
import { InterfaceCard } from './collection/InterfaceCard.js';
import { LiveMap } from './collection/LiveMap.js';
import { NoCollection } from './collection/NoCollection.js';
import { ProcessEquipment } from './collection/ProcessEquipment.js';
import { DailyStates } from './collection/DailyStates.js';
import { connectionStatus, receivingWindowMs, latestValues, tagOutcomes } from './collection/status.js';
import { freshWindowMs } from './collection/freshness.js';

export type { EquipmentRow } from './collection/helpers.js';

/** Whether collected values changed — the count, the latest receive time, and the last automatic collection round. The daily status bar re-reads on this */
function valuesVersion(values: readonly CollectedValueView[], sweep?: string): string {
  const latest = values.reduce((max, value) => {
    const at = value.receivedAt ?? value.observedAt;
    return at > max ? at : max;
  }, '');
  return `${values.length}|${latest}|${sweep ?? ''}`;
}

interface Props {
  interfaces: AidInterfaceView[];
  values: CollectedValueView[];
  /** Which model element each collected value attaches to */
  live?: LiveMapping;
  /** Automatic collection status (deployments with COLLECT_INTERVAL on) */
  auto?: { running: boolean; intervalMs?: number; lastSweep?: { startedAt: string; collected: number } };
  busy: boolean;
  onCollect: () => void;
  /** Open the create-collection-connection (AID) screen */
  onCreateAid: () => void;
  /** Delete the collection connection — when it was made wrong or is no longer used */
  onDeleteAid: () => void;
  /** Last manual collection result — the basis for the connection status */
  cycle?: CycleReportView;
  packageId?: string;
  /** A process (bundle) file is not a collection target — guide the user instead of suggesting it */
  unit?: 'equipment' | 'composite';
  /** Connect to the built-in virtual PLC (simulation). When absent the button is hidden (server with collection off) */
  onSimulate?: () => void;
  /**
   * For a process file — the equipment attached to the process and its collection connection status. Connect and collect right here
   * (user, 2026-10-01: "pick equipment → open file → connect PLC" is too long a path)
   */
  equipment?: EquipmentRow[];
  onOpenEquipment?: (packageId: string) => void;
  /** Open that equipment file and pop up the "create collection connection" dialog right away — the way to enter a field PLC address */
  onConnectEquipment?: (packageId: string) => void;
  onSimulateEquipment?: (packageId: string) => void;
  onCollectEquipment?: (packageId: string) => void;
  /** Translator — falls back to the Korean as-is when missing from the dictionary (i18n.ts) */
  t: (text: string) => string;
}

export function Collection({
  interfaces,
  values,
  live,
  auto,
  busy,
  onCollect,
  onCreateAid,
  onDeleteAid,
  cycle,
  packageId,
  unit,
  onSimulate,
  equipment,
  onOpenEquipment,
  onConnectEquipment,
  onSimulateEquipment,
  onCollectEquipment,
  t,
}: Props): React.JSX.Element {
  // Current time — redraw every 15 s so "N min ago" and the stale-connection check keep up on their own (even when no values arrive)
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // Important: a process (bundle) file — the process itself has no values to read. Instead show the **list of attached equipment**
  //    and connect/collect right here. It used to be a notice only, so you could connect only after picking equipment and opening its file
  if (unit === 'composite' && interfaces.length === 0) {
    // Daily status — one row per equipment with a collection connection (the whole process's day at a glance)
    const stateRows = (equipment ?? []).flatMap((row) => (row.packageId && row.connected ? [{ packageId: row.packageId, name: row.name }] : []));
    return (
      <>
        <ProcessEquipment
          rows={equipment ?? []}
          busy={busy}
          {...(onOpenEquipment ? { onOpenEquipment } : {})}
          {...(onConnectEquipment ? { onConnectEquipment } : {})}
          {...(onSimulateEquipment ? { onSimulateEquipment } : {})}
          {...(onCollectEquipment ? { onCollectEquipment } : {})}
          t={t}
        />
        {/* Same left/right padding as the equipment list above — outside the pane only the daily status sticks to the border (measured 0px on 2026-10-14) */}
        <div className="collection">
          <DailyStates rows={stateRows} holdMs={freshWindowMs(auto?.intervalMs)} version={auto?.lastSweep?.startedAt ?? ''} t={t} />
        </div>
      </>
    );
  }
  if (interfaces.length === 0) {
    return <NoCollection busy={busy} onCreateAid={onCreateAid} {...(onSimulate ? { onSimulate } : {})} t={t} />;
  }

  const latest = latestValues(values);
  const { waitingTags, failedTags } = tagOutcomes(cycle);

  /**
   * Download the address list — exports exactly what is on screen as a table.
   * Important: does not call the server again: if the screen and the table disagree, there is no way to tell which is right.
   */
  const exportAddresses = (): void => {
    // Tags that were "awaiting value" in the last collection — written distinctly from an empty cell
    const pending = new Set(
      (cycle?.interfaces ?? []).flatMap((entry) =>
        (entry.report?.pending ?? []).map((item) => item.propertyName),
      ),
    );
    const csv = addressCsv(addressRows(interfaces, values, live, pending));
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), tr('수집주소목록.csv'));
  };

  return (
    <div className="collection">
      <div className="collection-head">
        {/* Important: put the direction in the title. "OPC UA" alone cannot be told apart from publishing */}
        <h3 title={tr('설비(PLC) → 이 도구')}>{t('← 수집 — 설비에서 받아 오기')}</h3>
        {/* Action buttons go to the far right — cramped when stuck to the title */}
        <span className="spacer" />
        {/* The four buttons are one group — when the pane is narrow the whole group wraps to the next line (no single button dropping alone) */}
        <div className="row-buttons">
          <button
            className="primary"
            disabled={busy}
            title={tr('지금 한 번 접속해 값을 읽어 옵니다 — 주기 수집은 COLLECT_INTERVAL로 켭니다')}
            onClick={onCollect}
          >
            {tr('수집')}
          </button>
          <button
            onClick={exportAddresses}
            title={tr('이 설비에서 읽을 주소를 표 한 장으로 뽑습니다 — 시운전·검수에 넘기는 목록입니다')}
          >
            {tr('주소목록')}
          </button>
          <button disabled={busy} onClick={onCreateAid} title={tr('접속 주소·태그를 고칩니다')}>
            {tr('연결수정')}
          </button>
          <button className="danger" disabled={busy} onClick={onDeleteAid} title={tr('수집 연결(AID)을 지웁니다')}>
            {tr('연결삭제')}
          </button>
        </div>
      </div>

      {/* If automatic collection is running, say so — values are accumulating even without anyone pressing a button */}
      {auto?.running && (
        <p className="auto-note"><T k={'자동 수집 켜짐 — {0}초마다{1}'} v={[Math.round((auto.intervalMs ?? 0) / 1000), auto.lastSweep && (
            <>
              {' '}<T k={'· 마지막 {0} ({1}건)'} v={[localTime(auto.lastSweep.startedAt), auto.lastSweep.collected]} /></>
          )]} />
        </p>
      )}

      {interfaces.map((descriptor) => (
        <InterfaceCard
          key={descriptor.name}
          descriptor={descriptor}
          status={connectionStatus(descriptor.name, cycle, auto, packageId, latest, nowMs, receivingWindowMs(descriptor))}
          latest={latest}
          waitingTags={waitingTags}
          failedTags={failedTags}
          nowMs={nowMs}
          windowMs={freshWindowMs(auto?.intervalMs)}
        />
      ))}

      {/*
        Important: to publish current values through the standard API, **the AID name and the element idShort must match**.
           If they do not, values accumulate but are invisible from outside — this tells the user so here.
      */}
      {live && live.collected > 0 && <LiveMap live={live} />}

      {packageId && (
        <DailyStates rows={[{ packageId, name: tr('이 설비') }]} holdMs={freshWindowMs(auto?.intervalMs)} version={valuesVersion(values, auto?.lastSweep?.startedAt)} t={t} />
      )}

        <p className="hint">
          {t('수집값은 시계열에만 쌓입니다. 모델(AASX)에는 되쓰지 않습니다 — 산출물이 형식(Type)이기 때문입니다.')}{' '}
          <span className="mono">?live=true</span>
        </p>
      </div>
  );
}
