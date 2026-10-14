/**
 * ⚙ 설비 정보 — 공정 화면의 트리에서 설비 줄을 고르면 가운데에 그 설비에 맞는 동작이 나온다(초보자 원칙).
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화). 서브모델 추가는 그 설비 파일로 저장된다(App 의 onCreateSubmodel).
 */
import { T } from '../components/T.js';
import { tr } from '../i18n.js';

interface Props {
  label: string;
  fileName: string;
  busy: boolean;
  onAddSubmodel: () => void;
  onOpenFile: () => void;
  onClose: () => void;
}

export function AssetContext({ label, fileName, busy, onAddSubmodel, onOpenFile, onClose }: Props): React.JSX.Element {
  return (
    <div className="asset-context">
      <button className="link inspector-close" onClick={onClose}>
        {tr('닫기 ✕')}
      </button>
      <h2>⚙ {label}</h2>
      <p className="hint"><T k={'파일: {0}'} v={[<span className="mono">
          {fileName}
        </span>]} />
      </p>
      <div className="row-buttons asset-actions">
        <button
          className="primary"
          disabled={busy}
          title={tr('이 설비 파일에 서브모델을 만듭니다 — 지금 보는 공정 파일이 아니라 그 설비 파일에 저장됩니다')}
          onClick={onAddSubmodel}
        >
          {tr('이 설비에 서브모델 추가')}
        </button>
        <button
          disabled={busy}
          title={tr('이 설비 파일을 엽니다 — 지금 보는 공정 파일 대신 그 파일로 바뀝니다')}
          onClick={onOpenFile}
        >
          {tr('이 설비 파일 열기 →')}
        </button>
      </div>
      <p className="hint">
        {tr('밑에 펼쳐진 서브모델·요소는 여기서 바로 고칠 수 있습니다 — 저장하면 이 설비 파일이 바뀝니다.')}
      </p>
    </div>
  );
}
