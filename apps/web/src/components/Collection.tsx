/**
 * 수집 화면 — 기획서 M8.
 *
 * 두 가지를 한 자리에서 보여 준다: **무엇을 수집할 수 있는지**(AID)와 **마지막에 무엇이 들어왔는지**.
 *
 * 🔴 여기 보이는 값은 **모델이 아니다.** 값 동기화 A안에서 수집값은 시계열에만 쌓이고
 * 파일로 돌아가지 않는다 — 화면에서도 그 경계가 보이도록 트리·속성 칸과 섞지 않았다.
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
import { connectionStatus, latestValues, tagOutcomes } from './collection/status.js';
import { freshWindowMs } from './collection/freshness.js';

export type { EquipmentRow } from './collection/helpers.js';

/** 수집값이 바뀌었는지 — 개수와 가장 늦은 수신 시각, 자동 수집의 마지막 회차. 하루 상태 막대가 이것으로 다시 읽는다 */
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
  /** 수집값이 모델의 어느 요소에 얹히는지 */
  live?: LiveMapping;
  /** 자동 수집 상태 (COLLECT_INTERVAL 켠 배포) */
  auto?: { running: boolean; intervalMs?: number; lastSweep?: { startedAt: string; collected: number } };
  busy: boolean;
  onCollect: () => void;
  /** 수집 연결(AID) 만들기 화면 열기 */
  onCreateAid: () => void;
  /** 수집 연결 지우기 — 연결을 잘못 만들었거나 더 안 쓸 때 */
  onDeleteAid: () => void;
  /** 마지막 수동 수집 결과 — 연결 상태의 근거 */
  cycle?: CycleReportView;
  packageId?: string;
  /** 공정(묶음) 파일이면 수집 대상이 아니다 — 권하지 않고 안내한다 */
  unit?: 'equipment' | 'composite';
  /** 내장 가상 PLC로 연결(시뮬레이션). 없으면 버튼을 안 보인다(수집이 꺼진 서버) */
  onSimulate?: () => void;
  /**
   * 공정 파일일 때 — 공정에 매달린 설비와 수집 연결 상태. 여기서 바로 연결·수집한다
   * (사용자 2026-10-01: 「설비 고르기 → 파일 열기 → PLC 연결」은 경로가 길다)
   */
  equipment?: EquipmentRow[];
  onOpenEquipment?: (packageId: string) => void;
  /** 그 설비 파일을 열고 「수집 연결 만들기」 창을 바로 띄운다 — 현장 PLC 주소를 넣는 길 */
  onConnectEquipment?: (packageId: string) => void;
  onSimulateEquipment?: (packageId: string) => void;
  onCollectEquipment?: (packageId: string) => void;
  /** 번역기 — 사전에 없으면 한국어 그대로 (i18n.ts) */
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
  // 지금 시각 — 15초마다 다시 그려 「N분 전」과 끊김 판정이 저절로 따라가게 한다(값이 안 들어와도)
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // 🔴 공정(묶음) 파일 — 공정 자체에는 읽어 올 값이 없다. 대신 **매달린 설비 목록**을 보여 주고
  //    여기서 바로 연결·수집한다. 예전엔 안내문뿐이라 설비를 골라 파일을 열고 나서야 연결할 수 있었다
  if (unit === 'composite' && interfaces.length === 0) {
    // 하루 상태 — 수집 연결이 붙은 설비마다 한 줄(공정 전체의 하루가 한눈에)
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
        {/* 위 설비 목록과 같은 좌우 여백 — 칸 밖에 두면 하루 상태만 테두리에 붙는다(2026-10-14 실측 0px) */}
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
   * 주소 목록 내려받기 — 지금 화면에 있는 것을 그대로 표로 낸다.
   * 🔴 서버를 다시 부르지 않는다: 화면과 표가 어긋나면 어느 쪽이 맞는지 알 수 없다.
   */
  const exportAddresses = (): void => {
    // 마지막 수집에서 「값 대기」였던 태그 — 빈칸과 구별해 적는다
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
        {/* 🔴 방향을 제목에 박는다. 「OPC UA」만 쓰면 내주기와 구별되지 않는다 */}
        <h3 title={tr('설비(PLC) → 이 도구')}>{t('← 수집 — 설비에서 받아 오기')}</h3>
        {/* 동작 단추는 오른쪽 끝으로 — 제목과 붙어 있으면 답답하다 */}
        <span className="spacer" />
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

      {/* 자동 수집이 돌고 있으면 그 사실을 — 사람이 안 눌러도 쌓이고 있다는 것 */}
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
          status={connectionStatus(descriptor.name, cycle, auto, packageId)}
          latest={latest}
          waitingTags={waitingTags}
          failedTags={failedTags}
          nowMs={nowMs}
          windowMs={freshWindowMs(auto?.intervalMs)}
        />
      ))}

      {/*
        🔴 표준 API로 현재값을 내보내려면 **AID 이름과 요소 idShort가 맞아야** 한다.
           안 맞으면 값은 쌓이는데 밖에서는 안 보인다 — 그 사실을 여기서 알려 준다.
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
