/**
 * Fill from CSV — paste or upload an equipment register (one row = one machine) to fill values of many equipment files that share the same submodel at once.
 *
 * Steps: (1) put in the table → (2) pick the column identifying the equipment and the item for each column (preselected when names match) → (3) preview changed values → (4) apply.
 * Applying saves the submodel once per file — undo is also per file, with "Undo".
 * plan.ts does the calculation; inspector/applyValue.ts sets the values.
 */
import { useEffect, useMemo, useState } from 'react';
import { parseCsv } from '@aas/linter';
import { api, type PackageDescription } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { Dialog } from '../../ui/Dialog.js';
import { applyValue } from '../inspector/applyValue.js';
import { guessKeyColumn, leavesOf, planFill, suggestTarget, type FileTarget } from './plan.js';

interface Props {
  /** The currently picked submodel (JSON) — the submodel with this idShort is looked up in each file */
  submodel: Record<string, unknown>;
  busy: boolean;
  onClose: () => void;
  /** After applying — called with the notice text (re-reads the current file) */
  onDone: (notice: string) => void;
}

const nameOf = (item: PackageDescription): string[] =>
  [item.assetName, item.name?.replace(/\.aasx$/i, '')].filter((name): name is string => typeof name === 'string' && name !== '');

export function CsvFillDialog({ submodel, busy, onClose, onDone }: Props): React.JSX.Element {
  const idShort = String(submodel['idShort'] ?? '');
  const leaves = useMemo(() => leavesOf(submodel), [submodel]);
  const [text, setText] = useState('');
  const [keyColumn, setKeyColumn] = useState(0);
  const [mapping, setMapping] = useState<(string | undefined)[]>([]);
  const [files, setFiles] = useState<FileTarget[]>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  const table = useMemo(() => parseCsv(text), [text]);
  const headers = table[0] ?? [];
  const rows = table.slice(1);

  // When the table changes, guess the column mapping again — what a person corrected stays until the table changes
  const headerKey = headers.join('\u0001');
  useEffect(() => {
    const names = headerKey === '' ? [] : headerKey.split('\u0001');
    setKeyColumn(guessKeyColumn(names));
    setMapping(names.map((header) => suggestTarget(header, leaves)));
  }, [headerKey, leaves]);

  // Read each file's submodel with the same idShort up front — preview and apply use the same version
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = (await api.listPackages()).result;
      const targets: FileTarget[] = [];
      for (const item of list) {
        const found = (await api.submodels(item.packageId).catch(() => ({ result: [] }))).result.find((sm) => sm.idShort === idShort);
        targets.push({
          packageId: item.packageId,
          names: nameOf(item),
          ...(found ? { submodel: { id: String(found.id), content: found as unknown as Record<string, unknown> } } : {}),
        });
      }
      if (alive) setFiles(targets);
    })().catch((reason: unknown) => alive && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      alive = false;
    };
  }, [idShort]);

  const plans = files && rows.length > 0 ? planFill({ rows, keyColumn, mapping, files }) : [];
  const changing = plans.filter((plan) => plan.changes.length > 0);
  const valueCount = changing.reduce((sum, plan) => sum + plan.changes.length, 0);
  const problems = plans.filter((plan) => plan.problem);
  const fileName = (packageId?: string): string => (files?.find((file) => file.packageId === packageId)?.names[0] ?? packageId ?? '');

  const apply = async (): Promise<void> => {
    if (!files) return;
    setWorking(true);
    setError(undefined);
    const failed: string[] = [];
    for (const plan of changing) {
      const target = files.find((file) => file.packageId === plan.packageId)!.submodel!;
      const content = JSON.parse(JSON.stringify(target.content)) as Record<string, unknown>;
      for (const change of plan.changes) applyValue(content, change.path, change.after);
      try {
        const revision = (await api.revisions(plan.packageId!)).Submodel[target.id];
        await api.patchSubmodel(plan.packageId!, target.id, content, revision);
      } catch {
        failed.push(plan.key);
      }
    }
    setWorking(false);
    onDone(
      failed.length > 0
        ? fill(tr('CSV 값 반영 — 파일 {0}개 중 {1}개 실패: {2}'), { 0: changing.length, 1: failed.length, 2: failed.join(' · ') })
        : fill(tr('CSV 값 {0}개를 파일 {1}개에 반영했습니다 — 파일마다 「되돌리기」로 되돌릴 수 있습니다'), { 0: valueCount, 1: changing.length }),
    );
  };

  const readFile = async (file: File | undefined): Promise<void> => {
    if (file) setText(await file.text());
  };

  return (
    <Dialog className="wide csv-fill" label={tr('CSV에서 채우기')} onClose={onClose} close={{ text: tr('닫기'), label: tr('CSV에서 채우기 닫기') }}>
      <h3>{fill(tr('CSV에서 채우기 — {0}'), { 0: idShort })}</h3>
      <p className="hint">{tr('설비 대장처럼 한 줄에 설비 한 대인 표를 붙여 넣으십시오. 설비 이름 열로 파일을 찾아, 이 서브모델을 가진 파일마다 값을 채웁니다. 빈 칸은 지우지 않습니다.')}</p>
      <div className="csv-input">
        <textarea aria-label={tr('CSV 내용')} rows={5} value={text} placeholder={'Name,SerialNumber,YearOfConstruction\nRollFormingMachine_1,SN-0001,2026'} onChange={(event) => setText(event.target.value)} />
        <input type="file" accept=".csv,.txt,text/csv" aria-label={tr('CSV 파일 고르기')} onChange={(event) => void readFile(event.target.files?.[0])} />
      </div>

      {headers.length > 0 && (
        <table className="csv-map">
          <thead>
            <tr>
              <th>{tr('열')}</th>
              <th>{tr('넣을 항목')}</th>
              <th>{tr('첫 줄 값')}</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((header, column) => (
              <tr key={`${column}-${header}`}>
                <td className="mono">{header}</td>
                <td>
                  {column === keyColumn ? (
                    <span className="dim">{tr('설비 이름 (파일 찾기)')}</span>
                  ) : (
                    <select
                      aria-label={fill(tr('{0} 열을 넣을 항목'), { 0: header })}
                      value={mapping[column] ?? ''}
                      onChange={(event) => setMapping(mapping.map((path, index) => (index === column ? event.target.value || undefined : path)))}
                    >
                      <option value="">{tr('넣지 않음')}</option>
                      {leaves.map((leaf) => (
                        <option key={leaf.path} value={leaf.path}>
                          {leaf.label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="mono dim">{rows[0]?.[column] ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {headers.length > 0 && (
        <label className="csv-key">
          {tr('설비 이름 열')}
          <select aria-label={tr('설비 이름 열')} value={keyColumn} onChange={(event) => setKeyColumn(Number(event.target.value))}>
            {headers.map((header, column) => (
              <option key={`${column}-${header}`} value={column}>
                {header}
              </option>
            ))}
          </select>
        </label>
      )}

      {rows.length > 0 && !files && <p className="hint">{tr('파일을 읽는 중…')}</p>}
      {files && rows.length > 0 && (
        <div className="csv-preview">
          <p className="pick-title">{fill(tr('미리 보기 — 파일 {0}개 · 값 {1}개가 바뀝니다'), { 0: changing.length, 1: valueCount })}</p>
          <ul>
            {plans.map((plan, index) => (
              <li key={`${index}-${plan.key}`} className={plan.problem ? 'problem' : undefined}>
                <b className="mono">{plan.key || tr('(이름 없음)')}</b>{' '}
                {plan.problem === 'no-file' && <span>{tr('— 같은 이름의 파일이 없습니다')}</span>}
                {plan.problem === 'no-submodel' && <span>{fill(tr('— {0} 파일에 이 서브모델이 없습니다'), { 0: fileName(plan.packageId) })}</span>}
                {plan.problem === 'duplicate' && <span>{tr('— 위에 같은 설비가 이미 있어 건너뜁니다')}</span>}
                {!plan.problem && plan.changes.length === 0 && <span className="dim">{tr('— 바뀌는 값 없음')}</span>}
                {plan.changes.map((change) => (
                  <div key={change.path} className="mono change">
                    {change.path}: <span className="dim">{change.before || '—'}</span> → {change.after}
                  </div>
                ))}
              </li>
            ))}
          </ul>
          {problems.length > 0 && <p className="hint">{fill(tr('못 넣는 줄 {0}개는 건너뜁니다.'), { 0: problems.length })}</p>}
        </div>
      )}

      {error && <p className="note error">{error}</p>}
      <div className="row-buttons modal-actions">
        <button className="primary" disabled={busy || working || changing.length === 0} onClick={() => void apply()}>
          {working ? tr('반영 중…') : fill(tr('파일 {0}개에 값 {1}개 반영'), { 0: changing.length, 1: valueCount })}
        </button>
        <button onClick={onClose} disabled={working}>
          {tr('취소')}
        </button>
      </div>
    </Dialog>
  );
}
