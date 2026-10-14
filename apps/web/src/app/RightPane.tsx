/**
 * 오른쪽 칸 — 수집(OPC UA). 파일을 고르든 요소를 고르든 연결 상태는 늘 보인다.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업 · 클래스 이름 · 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름의 props 로 받는다.
 */
import { Collection } from '../components/Collection.js';
import { tr } from '../i18n.js';
import type { Screen } from './context.js';

export function RightPane(props: Pick<Screen, 'adding' | 'autoCollect' | 'busy' | 'equipmentRows' | 'fileUnit' | 'interfaces' | 'lastCycle' | 'live' | 'loadPackage' | 'onCollect' | 'onCollectEquipment' | 'onConnectEquipment' | 'onDeleteAid' | 'onSimulate' | 'onSimulateEquipment' | 'packageId' | 'setAdding' | 't' | 'values'>): React.JSX.Element {
  const { adding, autoCollect, busy, equipmentRows, fileUnit, interfaces, lastCycle, live, loadPackage, onCollect, onCollectEquipment, onConnectEquipment, onDeleteAid, onSimulate, onSimulateEquipment, packageId, setAdding, t, values } = props;

  return (
    <>
      {/*
        오른쪽 칸 — 수집(OPC UA)이 상시 자리한다.
        🔴 파일을 고르든 요소를 고르든 **연결 상태는 늘 보여야 한다**. 값이 들어오는지,
           밖으로 내주고 있는지는 편집 중에도 알아야 하는 정보다.
      */}
      <div className="right-pane">
        {/* 새 파일을 만드는 동안은 이전 파일의 수집 안내를 걷는다 — "이 파일"이 무엇인지 헷갈렸다(2026-09-07) */}
        {adding === 'new' && (
          <div className="collection empty">
            <h3>{tr('← 수집 — 설비에서 받아 오기')}</h3>
            <p className="hint">
              {tr('새 파일을 만들고 있습니다. 수집 연결은 파일이 만들어진 뒤 이 자리에서 잇습니다.')}
            </p>
          </div>
        )}
        {packageId && adding !== 'new' && (
          <Collection
            t={t}
            interfaces={interfaces}
            values={values}
            {...(live ? { live } : {})}
            {...(autoCollect?.running ? { auto: autoCollect } : {})}
            busy={busy}
            {...(lastCycle ? { cycle: lastCycle } : {})}
            {...(packageId ? { packageId } : {})}
            onCollect={() => void onCollect()}
            onCreateAid={() => setAdding('aid')}
            onDeleteAid={() => void onDeleteAid()}
            unit={fileUnit}
            {...(autoCollect?.collect ? { onSimulate: () => void onSimulate() } : {})}
            {...(fileUnit === 'composite'
              ? {
                  equipment: equipmentRows,
                  onOpenEquipment: (pid: string) => void loadPackage(pid),
                  onConnectEquipment: (pid: string) => void onConnectEquipment(pid),
                  ...(autoCollect?.collect
                    ? {
                        onSimulateEquipment: (pid: string) => void onSimulateEquipment(pid),
                        onCollectEquipment: (pid: string) => void onCollectEquipment(pid),
                      }
                    : {}),
                }
              : {})}
          />
        )}
      </div>
    </>
  );
}
