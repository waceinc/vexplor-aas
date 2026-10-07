/**
 * 수집 화면 — 기획서 M8.
 *
 * 두 가지를 한 자리에서 보여 준다: **무엇을 수집할 수 있는지**(AID)와 **마지막에 무엇이 들어왔는지**.
 *
 * 🔴 여기 보이는 값은 **모델이 아니다.** 값 동기화 A안에서 수집값은 시계열에만 쌓이고
 * 파일로 돌아가지 않는다 — 화면에서도 그 경계가 보이도록 트리·속성 칸과 섞지 않았다.
 */
import type { AidInterfaceView, CollectedValueView, CycleReportView, LiveMapping } from '../api.js';
import { addressCsv, addressRows } from '../addressList.js';
import { localTime } from '../model.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

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

export interface EquipmentRow {
  name: string;
  /** 공정 › 그룹 경로 */
  group: string;
  bulkCount: number;
  /** 파일이 열려 있지 않으면(예정) 없다 */
  packageId?: string;
  /** 수집 연결(AID)이 붙어 있는가 */
  connected: boolean;
}

/** 브라우저에 파일 하나를 건넨다 (DocAssets와 같은 방식) */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function displayValue(value: CollectedValueView): string {
  if (value.valueText !== undefined && value.valueText !== '') return value.valueText;
  if (value.valueNumber !== undefined) return String(value.valueNumber);
  return tr('(빈 값)');
}


/**
 * 수집 보고 한 인터페이스분 — 「값 대기」 칸까지 본다.
 *
 * 🔴 서버(`CollectReport`)는 실패(`failures`)와 **아직 값이 안 들어온 것**(`pending`)을 가른다.
 *    빈 목록일 땐 `pending`을 아예 싣지 않으므로 없어도 0으로 읽힌다 — 예전 서버에 붙어도 어긋나지 않는다.
 */
/** 실패 사유를 한 토막으로 — `BadNodeIdUnknown (0x80340000)` → `BadNodeIdUnknown` */
function shortReason(reason: string): string {
  const head = reason.split(/[\s(:]/)[0] ?? reason;
  return head.length > 0 && head.length <= 40 ? head : reason.slice(0, 40);
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
  // 🔴 공정(묶음) 파일 — 공정 자체에는 읽어 올 값이 없다. 대신 **매달린 설비 목록**을 보여 주고
  //    여기서 바로 연결·수집한다. 예전엔 안내문뿐이라 설비를 골라 파일을 열고 나서야 연결할 수 있었다
  if (unit === 'composite' && interfaces.length === 0) {
    const rows = equipment ?? [];
    const connected = rows.filter((row) => row.connected).length;
    return (
      <div className="collection empty">
        <h3>{t('← 수집 — 설비에서 받아 오기')}</h3>
        <p className="hint"><T k={'공정 파일은 수집 대상이 아닙니다 — 값은 <b>설비마다</b> 받습니다. 이 공정의 설비 {0}대 중 <b>{1}대 연결됨</b>.'} v={[rows.length, connected]} /></p>
        {rows.length === 0 ? (
          <p className="hint">{tr('아직 설비가 없습니다. 가운데 구성에서 「＋ 설비」로 넣으십시오.')}</p>
        ) : (
          <ul className="equip-list">
            {rows.map((row, index) => (
              <li key={`${row.name}-${index}`} className={row.connected ? 'on' : row.packageId ? 'off' : 'planned'}>
                <div className="equip-head">
                  <span className={`dot ${row.connected ? 'ok' : 'idle'}`} aria-hidden="true" />
                  <b>{row.name}</b>
                  {row.bulkCount > 1 && <span className="dim"> ×{row.bulkCount}</span>}
                  <span className="equip-state">
                    {!row.packageId ? tr('파일 없음(예정)') : row.connected ? tr('연결됨') : tr('연결 없음')}
                  </span>
                </div>
                {row.group && <div className="dim small">{row.group}</div>}
                {row.packageId && (
                  <div className="equip-actions">
                    {row.connected ? (
                      onCollectEquipment && (
                        <button
                      className="primary"
                      disabled={busy}
                      title={tr('이 설비에 한 번 접속해 값을 읽어 옵니다')}
                      onClick={() => onCollectEquipment(row.packageId!)}
                    >
                          {tr('수집')}
                        </button>
                      )
                    ) : (
                      <>
                        {onConnectEquipment && (
                          <button disabled={busy} onClick={() => onConnectEquipment(row.packageId!)} title={tr('그 설비 파일을 열고 현장 PLC 주소로 수집 연결을 만듭니다')}>
                            {tr('PLC 연결…')}
                          </button>
                        )}
                        {onSimulateEquipment && (
                          <button disabled={busy} onClick={() => onSimulateEquipment(row.packageId!)} title={tr('도구 안의 가상 PLC(시뮬레이션)에 바로 연결하고 한 번 수집합니다')}>
                            {tr('가상 PLC')}
                          </button>
                        )}
                      </>
                    )}
                    {onOpenEquipment && (
                      <button
                      className="link"
                      disabled={busy}
                      title={tr('이 설비 파일을 엽니다 — 지금 보는 공정 파일 대신 그 파일로 바뀝니다')}
                      onClick={() => onOpenEquipment(row.packageId!)}
                    >
                        {tr('열기 →')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="hint small"><T k={'🔴 연결하면 그 설비 파일에 수집 연결(AID)이 더해져 <b>시연본</b>이 됩니다. 원본 참조모델은 그대로 두고 「호기별로 나누기」로 만든 호기에서 연결하는 것을 권합니다. 모은 값은 「레퍼런스 번들」의 <b>실동작 증빙</b>으로 실립니다.'} /></p>
      </div>
    );
  }
  if (interfaces.length === 0) {
    return (
      <div className="collection empty">
        <h3>{t('← 수집 — 설비에서 받아 오기')}</h3>
        <p className="hint">
          {t('이 파일에는 아직 수집 연결(AID 서브모델)이 없습니다. 설비의 OPC UA 주소와 태그 목록만 있으면 바로 만들 수 있습니다.')}
        </p>
        <button
          className="primary"
          disabled={busy}
          title={tr('설비의 OPC UA 주소와 태그를 적으면 규격(IDTA-02017)대로 AID 서브모델을 지어 줍니다')}
          onClick={onCreateAid}
        >
          {t('수집 연결 만들기')}
        </button>
        {onSimulate && (
          <div className="simulate-box">
            <p className="hint">
              {t('실물 PLC가 없으면 — 도구 안의 가상 PLC로 바로 시험할 수 있습니다.')}
            </p>
            <button
              disabled={busy}
              title={tr('도구 안의 가상 PLC가 이 설비의 운전 데이터 이름대로 값을 흉내 냅니다 — 시연·재현용이며 값은 시뮬레이션입니다')}
              onClick={onSimulate}
            >
              {t('가상 PLC로 연결 (시뮬레이션)')}
            </button>
          </div>
        )}
      </div>
    );
  }

  /** property마다 가장 최근 값 하나 */
  const latest = new Map<string, CollectedValueView>();
  for (const value of values) {
    const key = `${value.interfaceName}/${value.propertyName}`;
    const current = latest.get(key);
    if (!current || value.observedAt > current.observedAt) latest.set(key, value);
  }

  /**
   * 연결 상태 — **마지막으로 실제 접속해 본 결과**로 판정한다.
   * 🔴 추측하지 않는다: 아직 한 번도 안 붙어 봤으면 "수집 전"이라고 말한다.
   *    (핑을 따로 치지 않는 이유: 수집과 다른 경로로 확인하면 "핑은 되는데 수집은 안 되는"
   *     어긋남이 생긴다 — 판정 근거는 수집 그 자체여야 한다)
   */
  const statusOf = (name: string): { kind: 'ok' | 'warn' | 'bad' | 'idle'; label: string } => {
    // ① 이 화면에서 방금 수집해 봤으면 그 결과가 가장 정확하다
    const entry = cycle?.interfaces.find((item) => item.name === name);
    if (entry) {
      if (entry.error) return { kind: 'bad', label: tr('접속 실패') };
      const report = entry.report;
      const failures = report?.failures.length ?? 0;
      const pending = report?.pending?.length ?? 0;
      /*
       * 🔴 **「값 대기」만으로는 노랗게 칠하지 않는다.**
       *    산출물이 Type/Template이라 빈 값이 정상이고, 설비 기동 직후에는 태그 수십 개가
       *    한꺼번에 대기 상태다. 그걸 「나쁜 태그 60」으로 세는 바람에 멀쩡한 설비를 두고
       *    "고장 났느냐"는 물음이 나왔다. 개수는 그대로 말하되, 경고로 올리지는 않는다.
       */
      const waiting = pending > 0 ? fill(tr(' · 값 대기 {0}'), { 0: pending }) : '';
      if (failures > 0) return { kind: 'warn', label: fill(tr('연결됨 · 나쁜 태그 {0}{1}'), { 0: failures, 1: waiting }) };
      return { kind: 'ok', label: fill(tr('연결됨{0}'), { 0: waiting }) };
    }
    // ② 자동 수집이 돌고 있으면 마지막 주기의 결과를 쓴다
    const sweep = auto?.lastSweep as
      | { results?: { packageId: string; collected: number; errors: string[] }[] }
      | undefined;
    const mine = sweep?.results?.find((item) => item.packageId === packageId);
    if (mine) {
      if (mine.errors.some((message) => message.startsWith(`${name}:`)))
        return { kind: 'bad', label: tr('접속 실패 (자동)') };
      if (mine.collected > 0) return { kind: 'ok', label: tr('연결됨 (자동)') };
    }
    return { kind: 'idle', label: tr('수집 전') };
  };

  /*
   * 마지막 수집에서 태그마다 무슨 일이 있었는지.
   * 🔴 「값이 없다」는 사실만으로는 **한 번도 안 읽어 본 것**과 **읽었는데 아직 안 들어온 것**을
   *    구별할 수 없다. 표에서 둘 다 「—」로 보이면 사용자가 원인을 짚을 수 없다.
   */
  const waitingTags = new Set<string>();
  const failedTags = new Map<string, string>();
  for (const entry of cycle?.interfaces ?? []) {
    const report = entry.report;
    for (const item of report?.pending ?? []) waitingTags.add(`${entry.name}/${item.propertyName}`);
    for (const item of report?.failures ?? []) failedTags.set(`${entry.name}/${item.propertyName}`, item.reason);
  }

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
        <div className="interface" key={descriptor.name}>
          <div className="interface-head">
            <b>{descriptor.title ?? descriptor.name}</b>
            <span className="chip">{descriptor.protocol}</span>
            {(() => {
              const status = statusOf(descriptor.name);
              // 색만으로 나누지 않는다 — 점 + 글자
              return (
                <span className={`conn ${status.kind}`} title={tr('마지막 수집 시도의 결과입니다')}>
                  <span className="dot" aria-hidden="true" />
                  {status.label}
                </span>
              );
            })()}
          </div>
          <div className="mono base">{descriptor.base ?? tr('주소 없음')}</div>

          <table>
            <thead>
              <tr>
                <th>{tr('항목')}</th>
                <th className="value-col">{tr('최근 값')}</th>
                <th className="time-col">{tr('시각')}</th>
              </tr>
            </thead>
            <tbody>
              {descriptor.properties.map((property) => {
                const key = `${descriptor.name}/${property.name}`;
                const value = latest.get(key);
                const failed = failedTags.get(key);
                const waiting = waitingTags.has(key);
                const badValue = value?.quality !== undefined && value.quality !== 'Good';
                return (
                  <tr key={property.name}>
                    <td>
                      <span className="tag-name">{property.name}</span>
                      {property.unit && <span className="unit"> {property.unit}</span>}
                      {/* 주소는 줄로 내려 둔다 — 값이 밀려나면 수집이 되는지 알 수 없다 */}
                      <div className="mono address" title={property.href ?? ''}>
                        {property.href ?? tr('주소 없음')}
                      </div>
                    </td>
                    <td className={`value-col${badValue || (!value && failed !== undefined) ? ' bad' : ''}`}>
                      {value ? (
                        <>
                          {displayValue(value)}
                          {badValue && <span className="unit"> {value.quality}</span>}
                        </>
                      ) : failed !== undefined ? (
                        /* 읽으러 갔다가 실패한 것 — 사유(StatusCode)를 짧게 같이 쓴다. title에만 두면
                           마우스를 올려야 보여서 「왜」를 못 읽고 지나쳤다(초보자 시연 실측) */
                        <span title={failed}><T k={'읽기 실패{0}'} v={[<span className="dim"> — {shortReason(failed)}</span>]} />
                        </span>
                      ) : waiting ? (
                        /*
                         * 🔴 「값 대기」 — 고장이 아니다. 색을 빼고(흐린 글자) **글자로 말한다**:
                         *    노랑으로 칠하면 옆줄의 진짜 실패와 구별되지 않는다
                         */
                        <span
                          className="waiting"
                          title={tr('설비에 붙어 읽었으나 아직 값이 올라오지 않았습니다. 고장이 아닙니다')}
                        >
                          {tr('값 대기')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="unit time-col">{value ? localTime(value.observedAt) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {/*
        🔴 표준 API로 현재값을 내보내려면 **AID 이름과 요소 idShort가 맞아야** 한다.
           안 맞으면 값은 쌓이는데 밖에서는 안 보인다 — 그 사실을 여기서 알려 준다.
      */}
      {live && live.collected > 0 && (
        <div className={`live-map${live.applied === 0 ? ' none' : ''}`}>
          <T k={'<b>표준 API로 내보내기</b> — 수집 {0}개 중 <b>{1}개</b>가 모델 요소와 이름이 맞습니다.'} v={[live.collected, live.applied]} />
          {live.applied > 0 && (
            <>
              {' '}<T k={'{0}로 읽으면 그 자리에 현장 값이 보입니다.'} v={[<span className="mono">?live=true</span>]} /></>
          )}
          {live.notes.filter((note) => note.outcome !== 'applied').length > 0 && (
            <div className="unmatched"><T k={'이름이 맞지 않아 못 얹은 것: {0}'} v={[live.notes
                .filter((note) => note.outcome !== 'applied')
                .map((note) => note.propertyName)
                .join(' · ')]} />
            </div>
          )}
        </div>
      )}

      <p className="hint">
        {t('수집값은 시계열에만 쌓입니다. 모델(AASX)에는 되쓰지 않습니다 — 산출물이 형식(Type)이기 때문입니다.')}{' '}
        <span className="mono">?live=true</span>
      </p>
    </div>
  );
}
