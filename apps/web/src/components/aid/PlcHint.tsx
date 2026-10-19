/**
 * Create collection link — the line under the endpoint for S7 and MC (VEXPLOR extension bindings, read only).
 * Split out of AddAid.tsx to keep it within its size.
 */
import { tr } from '../../i18n.js';
import type { PlcProtocol } from './plc.js';

export function PlcHint({ protocol }: { protocol: PlcProtocol }): React.JSX.Element {
  return (
    <p className="hint">
      {protocol === 'S7'
        ? tr('S7 은 설비에서 불러오기가 없습니다 — 아래 「＋ 손으로 입력」으로 TIA Portal · STEP 7 의 절대 주소(예: DB10.DBD4 · M10.3 · MW20)와 자료형을 적습니다. S7-1200 · 1500 은 「PUT/GET 통신 허용」을 켜고 DB 의 「최적화된 블록 액세스」를 꺼야 읽힙니다.')
        : tr('MC 프로토콜은 설비에서 불러오기가 없습니다 — 아래 「＋ 손으로 입력」으로 GX Works 의 디바이스(예: D100 · M50 · X1F · D10.3)와 자료형을 적습니다. 주소에 PLC 이더넷 설정의 포트와 기종(?series=Q · iQ-R · iQ-F)을 적습니다.')}{' '}
      {tr('S7 · MC 는 AID 1.1 표준 바인딩이 아니라 VEXPLOR 확장 표기입니다 — 값은 읽기만 하고 PLC 에 쓰지 않습니다.')}
    </p>
  );
}
