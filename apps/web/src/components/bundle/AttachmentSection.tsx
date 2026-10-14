/**
 * 레퍼런스 번들 — ④ 문서·첨부 — Use-Case · 가이던스 · 참고 자료(번들을 다시 열어도 남는다).
 * components/BundlePanel.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { useRef, useState } from 'react';
import { api, type BundleView } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';

interface Props {
  packageId: string;
  view: BundleView | undefined;
  /** 첨부를 올리거나 지운 뒤 번들을 다시 읽게 한다 */
  onChanged: () => void;
}

export function AttachmentSection({ packageId, view, onChanged }: Props): React.JSX.Element {
  /** 첨부 작업의 오류 — 화면 전체를 오류로 바꾸지 않는다 */
  const [note, setNote] = useState<string>();
  // i18n-ignore — 화면 글자가 아니라 **번들 ZIP 안의 폴더 이름**이다. 옮기면 서버가 모르는 폴더가 된다
  const [uploadFolder, setUploadFolder] = useState('01_UseCase문서');
  const fileInput = useRef<HTMLInputElement>(null);
  const attachments = view?.attachments ?? [];
  const onUpload = async (file: File): Promise<void> => {
    setNote(undefined);
    try {
      await api.putBundleFile(packageId, `${uploadFolder}/${file.name}`, file);
      setNote(fill(tr('「{0}」을(를) {1}에 넣었습니다 — 번들을 다시 열어도 남습니다.'), { 0: file.name, 1: uploadFolder }));
      onChanged();
    } catch (reason) {
      setNote(`⚠ ${(reason as Error).message}`);
    }
  };
  const onRemove = async (path: string): Promise<void> => {
    if (!globalThis.confirm(fill(tr('{0}\n\n번들 첨부에서 지웁니다. 계속할까요?'), { 0: path }))) return;
    setNote(undefined);
    try {
      await api.deleteBundleFile(packageId, path);
      onChanged();
    } catch (reason) {
      setNote(`⚠ ${(reason as Error).message}`);
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
        {note && <span className={note.startsWith('⚠') ? 'error-text small' : 'dim small'}>{note}</span>}
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
