/**
 * Attachments — attach, download, and remove the actual file that a File · Blob points to.
 * Split out of components/Inspector.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 */
import { tr } from '../../i18n.js';
import type { TreeNode } from '../../model.js';
import { T } from '../T.js';
import { attachedName } from './helpers.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  onUploadAttachment: (node: TreeNode, file: File) => void;
  onDownloadAttachment?: (node: TreeNode, filename: string) => void;
  onDeleteAttachment?: (node: TreeNode) => void;
  t: (text: string) => string;
}

export function AttachmentEditor({ node, busy, onUploadAttachment, onDownloadAttachment, onDeleteAttachment, t }: Props): React.JSX.Element {
  const raw = node.node;
  return (
    <div className="editor attachment">
      <h3>{t('첨부 파일')}</h3>
      {attachedName(raw) ? (
        <p className="note ok"><T k={'붙어 있음: {0}'} v={[attachedName(raw)]} /></p>
      ) : (
        <p className="note">{t('아직 파일이 붙어 있지 않습니다.')}</p>
      )}
      <label className="stack">
        {t('파일 고르기')}
        <input
          type="file"
          aria-label={tr('첨부 파일')}
          disabled={busy}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            // Clear the value so onChange fires even when the same file is picked again
            event.target.value = '';
            if (chosen) onUploadAttachment(node, chosen);
          }}
        />
      </label>
      <div className="row-buttons">
        {attachedName(raw) && onDownloadAttachment && (
          <button
            disabled={busy}
            title={t('이 요소에 담긴 파일을 내려받습니다')}
            onClick={() => onDownloadAttachment(node, attachedName(raw)!)}
          >
            {t('내려받기')}
          </button>
        )}
        {attachedName(raw) && onDeleteAttachment && (
          <button
            className="danger"
            disabled={busy}
            title={t('담긴 파일을 파일 안에서 뺍니다 — 되돌리려면 헤더의 ↶')}
            onClick={() => onDeleteAttachment(node)}
          >
            {t('첨부 지우기')}
          </button>
        )}
      </div>
    </div>
  );
}
