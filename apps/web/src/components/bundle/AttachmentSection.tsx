/**
 * Reference bundle — ④ documents & attachments — Use-Case · guidance · reference material (persists when the bundle is reopened).
 * Split out of components/BundlePanel.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 */
import { useRef, useState } from 'react';
import { api, type BundleView } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';

interface Props {
  packageId: string;
  view: BundleView | undefined;
  /** After uploading or removing an attachment, have the bundle reloaded */
  onChanged: () => void;
}

export function AttachmentSection({ packageId, view, onChanged }: Props): React.JSX.Element {
  /** Errors from attachment actions — do not turn the whole screen into an error */
  const [note, setNote] = useState<{ text: string; error: boolean }>();
  // i18n-ignore — not screen text but **folder names inside the bundle ZIP**. Translating them would make folders the server does not know
  const [uploadFolder, setUploadFolder] = useState('01_UseCase문서');
  const fileInput = useRef<HTMLInputElement>(null);
  const attachments = view?.attachments ?? [];
  const onUpload = async (file: File): Promise<void> => {
    setNote(undefined);
    try {
      await api.putBundleFile(packageId, `${uploadFolder}/${file.name}`, file);
      setNote({ text: fill(tr('「{0}」을(를) {1}에 넣었습니다 — 번들을 다시 열어도 남습니다.'), { 0: file.name, 1: uploadFolder }), error: false });
      onChanged();
    } catch (reason) {
      setNote({ text: (reason as Error).message, error: true });
    }
  };
  const onRemove = async (path: string): Promise<void> => {
    if (!globalThis.confirm(fill(tr('{0}\n\n번들 첨부에서 지웁니다. 계속할까요?'), { 0: path }))) return;
    setNote(undefined);
    try {
      await api.deleteBundleFile(packageId, path);
      onChanged();
    } catch (reason) {
      setNote({ text: (reason as Error).message, error: true });
    }
  };

  return (
    <>
      <h3>{tr('④ 문서·첨부 — Use-Case · 가이던스 · 참고 자료')}</h3>
      <p className="dim small"><T k={'여기 넣은 파일은 번들 ZIP의 해당 폴더에 들어가고, <b>번들을 열었다 다시 내보내도 그대로 남습니다.</b> 공정 파일(AASX)에는 섞이지 않아 해시가 바뀌지 않습니다.'} /></p>
      <div className="attach-upload">
        <select value={uploadFolder} onChange={(event) => setUploadFolder(event.target.value)}>
          {(view?.attachmentFolders ?? []).map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onUpload(file);
            event.target.value = '';
          }}
        />
        <button
        title={tr('Use-Case 문서·가이던스 같은 파일을 번들에 넣습니다 — 번들을 다시 열어도 남습니다')}
        onClick={() => fileInput.current?.click()}
        disabled={!view}
      >
          {tr('파일 넣기…')}
        </button>
        {note && <span className={note.error ? 'error-text small' : 'dim small'}>{note.text}</span>}
      </div>
      {attachments.length === 0 ? (
        <p className="dim"><T k={'아직 없습니다. 계획서의 번들 구성은 <b>Use-Case 문서 + 참조모델 + 가이던스</b>입니다 — Use-Case 문서와 장비별 가이던스를 넣으십시오.'} /></p>
      ) : (
        <table className="attach-table">
          <tbody>
            {attachments.map((attachment) => (
              <tr key={attachment.path}>
                <td className="dim">{attachment.path.split('/')[0]}</td>
                <td>
                  <button
              className="link"
              title={tr('이 파일을 내려받습니다')}
              onClick={() => void api.downloadBundleFile(packageId, attachment.path)}>
                    {attachment.path.split('/').slice(1).join('/')}
                  </button>
                </td>
                <td className="n dim">{(attachment.size / 1024).toFixed(1)} KB</td>
                <td>
                  <button className="link" onClick={() => void onRemove(attachment.path)} title={tr('번들 첨부에서 지웁니다')}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
