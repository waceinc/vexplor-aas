/**
 * Exports — equipment master, BOM, hierarchy, maintenance plan and documents as JSON or CSV for ERP / CMMS import,
 * and the integration bundle (all of them in one zip) for a system that takes everything in one step.
 *
 * Important: the CSV column keys are a frozen contract (docs/integration.md §7). "Korean headers" changes only the
 *    header line for people opening the file in Excel; an import program should use the key headers.
 * Important: the same address works without this screen — an ERP job can fetch it with the read-only token. The
 *    address is shown so the integrator copies it instead of reverse-engineering the query string.
 */
import { useState } from 'react';
import type { PackageDescription } from '../../api.js';
import { EXPORT_KINDS, bundlePath, exportPath, integrationApi, type ExportKind, type ExportOptions } from '../../api/integration.js';
import { currentLang, fill, tr } from '../../i18n.js';
import { CopyBox, ErrorNote, PackagePicker } from './common.js';

interface Props {
  packages: readonly PackageDescription[];
  origin: string;
}

function kindLabel(kind: ExportKind): string {
  if (kind === 'equipment') return tr('설비 마스터');
  if (kind === 'bom') return tr('BOM (구성품)');
  if (kind === 'hierarchy') return tr('공정 계층');
  if (kind === 'maintenance') return tr('보전 계획');
  return tr('문서 목록');
}

function kindHint(kind: ExportKind): string {
  if (kind === 'equipment') return tr('Instance 설비마다 한 줄 — 명판 · 위치 · 외부 번호. ERP 설비 마스터용');
  if (kind === 'bom') return tr('설비의 구성품 — 수량과 ERP 자재번호. 계층의 맨 위가 이 설비가 아니면 거절합니다');
  if (kind === 'hierarchy') return tr('공정 파일의 회사 · 라인 · 설비 계층 — MES 설비 계층용');
  if (kind === 'maintenance') return tr('보전 작업과 단계 — 주기가 모델에 없으면 비워 둡니다(지어내지 않음)');
  return tr('설명서 · 도면 파일 목록과 내려받을 주소, sha256');
}

export function ExportsTab({ packages, origin }: Props): React.JSX.Element {
  const [packageId, setPackageId] = useState<string>();
  const [format, setFormat] = useState<'json' | 'csv'>('csv');
  const [bom, setBom] = useState(true);
  const [koreanHeaders, setKoreanHeaders] = useState(false);
  const [includeTypes, setIncludeTypes] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);

  const options = (kind: ExportKind): ExportOptions => ({
    ...(packageId ? { packageId } : {}),
    format,
    bom,
    koreanHeaders,
    includeTypes: kind === 'equipment' && includeTypes,
    lang: currentLang(),
  });

  const run = async (fetchFile: () => Promise<string>): Promise<void> => {
    setError(undefined);
    setSaved(undefined);
    setBusy(true);
    try {
      setSaved(await fetchFile());
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="integration-tab">
      <div className="row-buttons wrap">
        <PackagePicker packages={packages} value={packageId} onChange={setPackageId} allowAll />
        <label className="integration-picker">
          <span>{tr('형식')}</span>
          <select aria-label={tr('형식')} value={format} onChange={(event) => setFormat(event.target.value === 'json' ? 'json' : 'csv')}>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
      </div>
      {format === 'csv' && (
        <div className="row-buttons wrap">
          <label className="check">
            <input type="checkbox" checked={bom} onChange={(event) => setBom(event.target.checked)} />
            <span>{tr('UTF-8 BOM 붙이기 (엑셀에서 한글이 깨지지 않게)')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={koreanHeaders} onChange={(event) => setKoreanHeaders(event.target.checked)} />
            <span>{tr('한국어 머리글 (사람이 볼 때 — 프로그램이 읽을 때는 끄십시오)')}</span>
          </label>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={includeTypes} onChange={(event) => setIncludeTypes(event.target.checked)} />
        <span>{tr('Type(형식) 파일도 설비 마스터에 넣기 — 표시가 붙습니다')}</span>
      </label>

      <ErrorNote error={error} />
      {saved && <p className="note ok">{fill(tr('{0} 을(를) 내려받았습니다.'), { 0: saved })}</p>}

      <section>
        <h3>{tr('전체 묶음 — 다른 시스템에 한 번에 넘길 때')}</h3>
        <ul className="export-list">
          <li>
            <button type="button" disabled={busy} onClick={() => void run(() => integrationApi.downloadBundle({ ...(packageId ? { packageId } : {}), lang: currentLang() }))}>
              {tr('전체 묶음(zip) 내려받기')}
            </button>
            <span className="hint">{tr('아래 다섯 가지를 JSON 으로 zip 하나에 — 파일마다 sha256 이 적힌 목록(manifest.json)이 함께 들어갑니다')}</span>
          </li>
        </ul>
      </section>

      <ul className="export-list">
        {EXPORT_KINDS.map((kind) => {
          const needsFile = kind !== 'equipment' && !packageId;
          return (
            <li key={kind}>
              <button type="button" disabled={busy || needsFile} onClick={() => void run(() => integrationApi.downloadExport(kind, options(kind)))}>
                {fill(tr('{0} 내려받기'), { 0: kindLabel(kind) })}
              </button>
              <span className="hint">{needsFile ? tr('파일을 하나 고르면 내려받을 수 있습니다') : kindHint(kind)}</span>
            </li>
          );
        })}
      </ul>

      <section>
        <h3>{tr('같은 내용을 ERP 가 직접 읽는 주소')}</h3>
        <CopyBox value={`${origin}${exportPath('equipment', options('equipment'))}`} label={tr('설비 마스터 주소')} />
        <CopyBox value={`${origin}${bundlePath(packageId ? { packageId } : {})}`} label={tr('전체 묶음 주소')} />
      </section>
    </div>
  );
}
