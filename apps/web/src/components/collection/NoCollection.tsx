/**
 * Collection pane — when this file has no collection connection (AID) yet — create one · test with the virtual PLC.
 * Extracted from components/Collection.tsx (2026-10-13 componentization) — markup · comments · judgements moved verbatim at the time.
 */
import { tr } from '../../i18n.js';

interface Props {
  busy: boolean;
  onCreateAid: () => void;
  onSimulate?: () => void;
  t: (text: string) => string;
}

export function NoCollection({ busy, onCreateAid, onSimulate, t }: Props): React.JSX.Element {
  return (
    <div className="collection empty">
      <h3>{t('← 수집 — 설비에서 받아 오기')}</h3>
      <p className="hint">
        {t('이 파일에는 아직 수집 연결(AID 서브모델)이 없습니다. 설비의 접속 주소(OPC UA · Modbus TCP · MQTT)와 태그 목록만 있으면 바로 만들 수 있습니다.')}
      </p>
      <button
        className="primary"
        disabled={busy}
        title={tr('설비의 접속 주소(OPC UA · Modbus TCP · MQTT)와 태그를 적으면 규격(IDTA-02017)대로 AID 서브모델을 지어 줍니다')}
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
