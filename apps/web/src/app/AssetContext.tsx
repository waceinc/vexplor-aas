/**
 * Equipment info — selecting an equipment row in the process tree shows actions for that equipment in the middle pane (beginner principle).
 * Split out of App.tsx (componentization, 2026-10-13). Adding a submodel saves it to that equipment file (App's onCreateSubmodel).
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
