/**
 * Right pane — collection (OPC UA). Connection status stays visible whether a file or an element is selected.
 * Split out of App.tsx (componentization, 2026-10-13) — markup, class names and comments are verbatim from before the move,
 * and the state and actions it uses arrive as props with the same names.
 */
import { Collection } from '../components/Collection.js';
import { tr } from '../i18n.js';
import type { Screen } from './context.js';

export function RightPane(props: Pick<Screen, 'adding' | 'autoCollect' | 'busy' | 'equipmentRows' | 'fileUnit' | 'interfaces' | 'lastCycle' | 'live' | 'loadPackage' | 'onCollect' | 'onCollectEquipment' | 'onConnectEquipment' | 'onDeleteAid' | 'onSimulate' | 'onSimulateEquipment' | 'packageId' | 'setAdding' | 't' | 'values'>): React.JSX.Element {
  const { adding, autoCollect, busy, equipmentRows, fileUnit, interfaces, lastCycle, live, loadPackage, onCollect, onCollectEquipment, onConnectEquipment, onDeleteAid, onSimulate, onSimulateEquipment, packageId, setAdding, t, values } = props;

  return (
    <>
      {/*
        Right pane — permanent home of collection (OPC UA).
        Important: whether a file or an element is selected, **connection status must always be visible**. Whether values are coming in
           or being served out is information needed even while editing.
      */}
      <div className="right-pane">
        {/* While creating a new file, hide the previous file's collection guidance — it was unclear what "this file" referred to (2026-09-07) */}
        {adding === 'new' && (
          <div className="collection empty">
            <h3>{tr('← 수집 — 설비에서 받아 오기')}</h3>
            <p className="hint">
              {tr('새 파일을 만들고 있습니다. 수집 연결은 파일이 만들어진 뒤 이 자리에서 연결합니다.')}
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
