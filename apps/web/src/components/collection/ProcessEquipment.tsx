/**
 * 수집 칸 — 공정(묶음) 파일 — 공정 자체에는 읽어 올 값이 없다. 매달린 설비 목록을 보여 주고 여기서 바로 연결·수집한다.
 * components/Collection.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석·판정은 옮기기 전 글자 그대로다.
 */
import { tr } from '../../i18n.js';
import { T } from '../T.js';
import type { EquipmentRow } from './helpers.js';

interface Props {
  rows: EquipmentRow[];
  busy: boolean;
  onOpenEquipment?: (packageId: string) => void;
  onConnectEquipment?: (packageId: string) => void;
  onSimulateEquipment?: (packageId: string) => void;
  onCollectEquipment?: (packageId: string) => void;
  t: (text: string) => string;
}

export function ProcessEquipment({ rows, busy, onOpenEquipment, onConnectEquipment, onSimulateEquipment, onCollectEquipment, t }: Props): React.JSX.Element {
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
