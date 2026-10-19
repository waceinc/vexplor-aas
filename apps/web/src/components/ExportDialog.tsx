/**
 * Download as a metamodel version — pick V3.0 · V3.1 · V3.2 and see what that version costs **before** the file is made.
 *
 * Important: the default is the version the file came in as (a 3.1 file goes out as 3.1, a model made here as 3.1).
 *    Picking a lower version shows the fields that version does not have (they are left out of the file) and the
 *    values it cannot say (the download stops — writing a look-alike value would state something false). Only an
 *    explicit "keep it as it is" writes such a file, and the window says it will fail that version's schema.
 * Important: 3.1 and 3.2 accept only URIs as attachment paths, so names with spaces or Korean letters are
 *    percent-encoded together with the files inside the package. The window lists them; reopening shows the original names.
 */
import { useEffect, useState } from 'react';
import { api, type ExportPreview, type MetamodelVersion, type PackageMetamodel } from '../api.js';
import { fill, tr } from '../i18n.js';
import { readableName } from './inspector/helpers.js';

const VERSIONS: readonly MetamodelVersion[] = ['3.0', '3.1', '3.2'];

/** What each version is for — the reason someone would pick it */
function purposeOf(version: MetamodelVersion): string {
  if (version === '3.0') return tr('공식 검증기(aas-test-engines 1.0.3)가 판정하는 판');
  if (version === '3.1') return tr('KOSMO가 요구하는 판 · IDTA 서식의 판');
  return tr('최신 판 — 받는 쪽이 V3.2를 읽는지 먼저 확인하십시오');
}

interface Props {
  packageId: string;
  /** The version the file came in as. Absent on an older server — read as 3.0 */
  stored: PackageMetamodel | undefined;
  busy: boolean;
  onDownload: (options: { metamodel: MetamodelVersion; keep: boolean }) => Promise<void>;
  onClose: () => void;
}

export function ExportDialog({ packageId, stored, busy, onDownload, onClose }: Props): React.JSX.Element {
  const own = stored?.version ?? '3.0';
  const [version, setVersion] = useState<MetamodelVersion>(own);
  const [preview, setPreview] = useState<ExportPreview>();
  const [failed, setFailed] = useState<string>();
  const [keep, setKeep] = useState(false);

  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setFailed(undefined);
    setKeep(false);
    api
      .exportPreview(packageId, version)
      .then((answer) => {
        if (live) setPreview(answer);
      })
      .catch((error: unknown) => {
        if (live) setFailed(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [packageId, version]);

  const dropped = preview?.entries.filter((e) => e.kind === 'dropped') ?? [];
  const refused = preview?.entries.filter((e) => e.kind === 'unrepresentable') ?? [];
  const canDownload = preview !== undefined && !busy && (!preview.blocked || keep);

  return (
    <div className="export-version">
      <h3>{tr('AASX 내려받기 — 메타모델 판')}</h3>
      <p className="note">
        {fill(tr('이 파일의 판: V{0}'), { 0: own })}
        {stored?.inferred ? ` ${tr('(JSON이라 판 표시가 없어 내용으로 정했습니다)')}` : ''}
      </p>

      <fieldset className="stack">
        <legend>{tr('내보낼 판')}</legend>
        {VERSIONS.map((v) => (
          <label key={v} className="choice">
            <input type="radio" name="metamodel" value={v} checked={version === v} disabled={busy} onChange={() => setVersion(v)} />
            <span>
              V{v}
              {v === own ? ` ${tr('(이 파일의 판)')}` : ''} — {purposeOf(v)}
            </span>
          </label>
        ))}
      </fieldset>

      {!preview && !failed && <p className="note">{tr('이 판으로 쓰면 무엇이 달라지는지 확인하고 있습니다…')}</p>}
      {failed && <p className="note warning">{failed}</p>}

      {preview && preview.lossless && preview.renamed.length === 0 && (
        <p className="note ok">{fill(tr('V{0}으로 써도 빠지거나 바뀌는 것이 없습니다.'), { 0: preview.version })}</p>
      )}

      {refused.length > 0 && (
        <div className="note warning" role="alert">
          <p>{fill(tr('V{0}으로 쓸 수 없는 값이 {1}건 있어 내려받기를 막았습니다.'), { 0: preview!.version, 1: refused.length })}</p>
          <ul>
            {refused.map((entry) => (
              <li key={entry.pointer}>
                <span className="mono">{entry.pointer}</span> — {entry.message}
              </li>
            ))}
          </ul>
          <label className="choice">
            <input type="checkbox" checked={keep} disabled={busy} onChange={(event) => setKeep(event.target.checked)} />
            <span>{fill(tr('그대로 두고 내려받기 — 이 파일은 V{0} 공식 스키마를 통과하지 못합니다'), { 0: preview!.version })}</span>
          </label>
        </div>
      )}

      {dropped.length > 0 && (
        <div className="note warning">
          <p>{fill(tr('V{0}에는 없는 칸 {1}건이 파일에서 빠집니다.'), { 0: preview!.version, 1: dropped.length })}</p>
          <ul>
            {dropped.map((entry) => (
              <li key={entry.pointer}>
                <span className="mono">{entry.pointer}</span> — {entry.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && preview.renamed.length > 0 && (
        <div className="note">
          <p>
            {fill(tr('V{0}은 첨부 경로에 URI 형식만 받습니다 — 파일 이름 {1}건을 퍼센트 인코딩하고 패키지 안의 파일 이름도 같이 바꿉니다. 이 도구로 다시 열면 원래 이름으로 보입니다.'), {
              0: preview.version,
              1: preview.renamed.length,
            })}
          </p>
          <ul>
            {preview.renamed.map((entry) => (
              <li key={entry.pointer}>
                {readableName(entry.from)} → <span className="mono">{entry.to}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row-buttons actions">
        <button className="primary" disabled={!canDownload} onClick={() => void onDownload({ metamodel: version, keep })}>
          {fill(tr('V{0}으로 내려받기'), { 0: version })}
        </button>
        <button onClick={onClose}>{tr('닫기')}</button>
      </div>
    </div>
  );
}
