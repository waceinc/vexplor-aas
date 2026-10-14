/**
 * Serving dialog — while this tool serves values as an OPC UA server, it pins down **what kind of address** that address is.
 * Important: the incident was caused by "two addresses that both just looked like 'address'" (the serving address was entered in the equipment address field).
 * Split out of App.tsx (componentization, 2026-10-13).
 */
import { T } from '../components/T.js';
import { tr } from '../i18n.js';
import { Dialog } from '../ui/Dialog.js';

interface Props {
  endpoint?: string;
  packages: number;
  variables: number;
  onClose: () => void;
}

export function OpcuaDialog({ endpoint, packages, variables, onClose }: Props): React.JSX.Element {
  return (
    <Dialog className="opcua-out" label={tr('내주는 중')} onClose={onClose} close={{ text: tr('닫기 ✕'), label: tr('내주기 창 닫기') }}>
      <h3>{tr('→ 다른 시스템에 값 내주는 중')}</h3>
      <p className="flow"><T k={'[설비·PLC] ──▶ <b>[이 도구]</b> ──▶ [MES·SCADA]'} /></p>
      <p className="hint"><T k={'작성한 AAS를 OPC UA 서버로 내주고 있습니다. 상위 앱이 <b>구독</b>으로 값을 받아 갑니다 — 값이 바뀌면 이쪽에서 먼저 알립니다.'} /></p>
      <dl>
        <dt>{tr('상위 앱에 알려 줄 주소')}</dt>
        <dd className="mono">{endpoint}</dd>
        <dt>{tr('내주는 파일')}</dt>
        <dd>
          <T k={'{0}개 · 변수 {1}개'} v={[packages, variables]} /></dd>
      </dl>
      <p className="note warn"><T k={'주의 — 이 주소는 <b>남이 접속해 올 주소</b>입니다. 수집 연결의 「설비 주소」 칸에 넣는 주소가 아닙니다 — 거기 넣으면 우리가 내준 값을 우리가 다시 읽게 됩니다.'} /></p>
      <p className="hint">{tr('전부 읽기 전용입니다. 밖에서 값을 바꿀 수 없습니다.')}</p>
    </Dialog>
  );
}
