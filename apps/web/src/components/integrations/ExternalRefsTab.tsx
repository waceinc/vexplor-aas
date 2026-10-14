/**
 * External references — the ERP / MES / CMMS numbers of an asset (equipment number, functional location, material…).
 *
 * Important: these live **next to** the AASX, not in it (design D1): AASX files leave the company, internal numbers
 *    should not. Only a ref marked "publish" is written into the shell's specificAssetIds — and then it also becomes
 *    findable through /lookup/shells. Cost centres and refs marked "sensitive" are never published, exported or sent.
 * Important: the same (system, type, id) may belong to one asset only. A 409 lists who already holds it, so the person
 *    can fix the right file instead of guessing.
 */
import { useEffect, useState } from 'react';
import type { PackageDescription } from '../../api.js';
import { claimsOf, fieldErrorsOf, integrationApi, rejectedImportOf, isStale, type ExternalRef, type ExternalRefsDoc, type RefClaim, type RefImportResult } from '../../api/integration.js';
import { fill, tr } from '../../i18n.js';
import { ErrorNote, PackagePicker, StaleNote } from './common.js';

type SubjectKind = 'asset' | 'bomChild' | 'consumable' | 'tool';
const SUBJECT_KINDS: readonly SubjectKind[] = ['asset', 'bomChild', 'consumable', 'tool'];

export interface RefRow {
  subjectKind: SubjectKind;
  globalAssetId: string;
  key: string;
  system: string;
  type: string;
  id: string;
  publish: boolean;
  sensitive: boolean;
  externalSubjectId: string;
}

export function toRows(doc: ExternalRefsDoc): RefRow[] {
  return doc.subjects.flatMap(({ subject, refs }) =>
    refs.map((ref) => ({
      subjectKind: subject.kind,
      globalAssetId: subject.globalAssetId,
      key: 'key' in subject ? subject.key : '',
      system: ref.system,
      type: ref.type,
      id: ref.id,
      publish: ref.publish === true,
      sensitive: ref.sensitive === true,
      externalSubjectId: ref.externalSubjectId ?? '',
    })),
  );
}

/** Rows back to subjects — rows of the same subject are grouped in first-seen order */
export function toDoc(rows: readonly RefRow[], previous: ExternalRefsDoc): ExternalRefsDoc {
  const groups = new Map<string, ExternalRefsDoc['subjects'][number]>();
  for (const row of rows) {
    const keyed = row.subjectKind === 'consumable' || row.subjectKind === 'tool';
    const id = `${row.subjectKind}|${row.globalAssetId}${keyed ? `|${row.key}` : ''}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        subject: keyed
          ? { kind: row.subjectKind as 'consumable' | 'tool', globalAssetId: row.globalAssetId, key: row.key }
          : { kind: row.subjectKind as 'asset' | 'bomChild', globalAssetId: row.globalAssetId },
        refs: [],
      };
      groups.set(id, group);
    }
    const ref: ExternalRef = { system: row.system.trim(), type: row.type.trim(), id: row.id.trim() };
    if (row.publish) ref.publish = true;
    if (row.sensitive) ref.sensitive = true;
    if (row.externalSubjectId.trim()) ref.externalSubjectId = row.externalSubjectId.trim();
    group.refs.push(ref);
  }
  return { ...previous, schema: 'vexplor.externalRefs/1', subjects: [...groups.values()] };
}

/** Checks the server would refuse anyway — said before the round trip, in the row's own words */
export function rowProblems(rows: readonly RefRow[]): string[] {
  const problems: string[] = [];
  rows.forEach((row, index) => {
    const at = index + 1;
    if (!row.system.trim() || !row.type.trim() || !row.id.trim()) problems.push(fill(tr('{0}번째 줄: 시스템 · 종류 · 번호를 모두 적으십시오.'), { 0: at }));
    if (row.system.includes('|')) problems.push(fill(tr('{0}번째 줄: 시스템 이름에 | 를 쓸 수 없습니다.'), { 0: at }));
    if (row.type === 'costCenter' && row.publish) problems.push(fill(tr('{0}번째 줄: 원가센터(costCenter)는 공개할 수 없습니다.'), { 0: at }));
    if (row.sensitive && row.publish) problems.push(fill(tr('{0}번째 줄: 민감한 번호는 공개할 수 없습니다.'), { 0: at }));
  });
  return problems;
}

function Claims({ claims }: { claims: readonly RefClaim[] }): React.JSX.Element | null {
  if (claims.length === 0) return null;
  return (
    <div className="note error" role="alert">
      <p>{tr('같은 번호를 이미 다른 대상이 쓰고 있습니다:')}</p>
      <ul>
        {claims.map((claim) => (
          <li key={`${claim.packageId}-${claim.subject}-${claim.id}`} className="mono">
            {claim.system} · {claim.type} · {claim.id} → {claim.claimedBy?.packageId ?? claim.packageId} ({claim.claimedBy?.subject ?? claim.subject})
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Props {
  edit: boolean;
  packages: readonly PackageDescription[];
}

export function ExternalRefsTab({ edit, packages }: Props): React.JSX.Element {
  const [packageId, setPackageId] = useState<string>();
  const [loaded, setLoaded] = useState<{ value: ExternalRefsDoc; revision: number }>();
  const [rows, setRows] = useState<RefRow[]>([]);
  const [error, setError] = useState<unknown>();
  const [claims, setClaims] = useState<RefClaim[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const asset = packages.find((item) => item.packageId === packageId)?.globalAssetId ?? '';

  useEffect(() => {
    setLoaded(undefined);
    setRows([]);
    setStale(false);
    setClaims([]);
    setProblems([]);
    setNotice(undefined);
    setError(undefined);
    if (!packageId) return;
    let alive = true;
    integrationApi
      .externalRefs(packageId)
      .then((next) => {
        if (!alive) return;
        setLoaded(next);
        setRows(toRows(next.value));
      })
      .catch((caught: unknown) => alive && setError(caught));
    return () => {
      alive = false;
    };
  }, [packageId, generation]);

  const update = (index: number, patch: Partial<RefRow>): void => setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const save = async (): Promise<void> => {
    if (!packageId || !loaded) return;
    setError(undefined);
    setClaims([]);
    setNotice(undefined);
    const found = rowProblems(rows);
    setProblems(found);
    if (found.length > 0) return;
    try {
      const next = await integrationApi.saveExternalRefs(packageId, toDoc(rows, loaded.value), loaded.revision);
      setLoaded(next);
      setRows(toRows(next.value));
      const added = next.projected?.added.length ?? 0;
      const removed = next.projected?.removed.length ?? 0;
      setNotice(
        added + removed > 0
          ? fill(tr('저장했습니다. 설비 식별 정보(specificAssetIds)에 {0}개를 더하고 {1}개를 뺐습니다 — 되돌리기로 취소할 수 있습니다.'), { 0: added, 1: removed })
          : tr('저장했습니다.'),
      );
    } catch (caught) {
      if (isStale(caught)) setStale(true);
      else if (claimsOf(caught).length > 0) setClaims(claimsOf(caught));
      else if (fieldErrorsOf(caught).length > 0) setProblems(fieldErrorsOf(caught).map((item) => `${item.path} ${item.message}`));
      else setError(caught);
    }
  };

  return (
    <div className="integration-tab">
      <section>
        <h3>{tr('파일별 외부 번호')}</h3>
        <p className="hint">{tr('ERP · MES · CMMS 가 이 설비를 부르는 번호입니다. AASX 파일에는 들어가지 않고, 「공개」에 표시한 것만 설비 식별 정보(specificAssetIds)에 실립니다.')}</p>
        <PackagePicker packages={packages} value={packageId} onChange={setPackageId} />
        <ErrorNote error={error} />
        {stale && <StaleNote onReload={() => setGeneration((value) => value + 1)} />}
        <Claims claims={claims} />
        {problems.length > 0 && (
          <ul className="note error" role="alert">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {notice && <p className="note ok">{notice}</p>}
        {loaded && (
          <>
            {rows.length > 0 && (
              <div className="table-scroll">
                <table className="integration-table">
                  <thead>
                    <tr>
                      <th>{tr('대상')}</th>
                      <th>{tr('대상 키')}</th>
                      <th>{tr('시스템')}</th>
                      <th>{tr('종류')}</th>
                      <th>{tr('번호')}</th>
                      <th>{tr('공개')}</th>
                      <th>{tr('민감')}</th>
                      <th>{tr('발급 시스템 IRI')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const line = (name: string): string => fill(tr('{0}번째 줄 {1}'), { 0: index + 1, 1: name });
                      return (
                        <tr key={index}>
                          <td>
                            <select aria-label={line(tr('대상'))} disabled={!edit} value={row.subjectKind} onChange={(event) => update(index, { subjectKind: event.target.value as SubjectKind })}>
                              {SUBJECT_KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                  {kind}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input aria-label={line(tr('대상 키'))} disabled={!edit || (row.subjectKind !== 'consumable' && row.subjectKind !== 'tool')} value={row.key} onChange={(event) => update(index, { key: event.target.value })} />
                          </td>
                          <td>
                            <input aria-label={line(tr('시스템'))} disabled={!edit} placeholder="sap-s4:PRD:100" value={row.system} onChange={(event) => update(index, { system: event.target.value })} />
                          </td>
                          <td>
                            <input aria-label={line(tr('종류'))} disabled={!edit} placeholder="equipment" value={row.type} onChange={(event) => update(index, { type: event.target.value })} />
                          </td>
                          <td>
                            <input aria-label={line(tr('번호'))} disabled={!edit} value={row.id} onChange={(event) => update(index, { id: event.target.value })} />
                          </td>
                          <td>
                            <input type="checkbox" aria-label={line(tr('공개'))} disabled={!edit} checked={row.publish} onChange={(event) => update(index, { publish: event.target.checked })} />
                          </td>
                          <td>
                            <input type="checkbox" aria-label={line(tr('민감'))} disabled={!edit} checked={row.sensitive} onChange={(event) => update(index, { sensitive: event.target.checked })} />
                          </td>
                          <td>
                            <input aria-label={line(tr('발급 시스템 IRI'))} disabled={!edit} value={row.externalSubjectId} onChange={(event) => update(index, { externalSubjectId: event.target.value })} />
                          </td>
                          <td>
                            <button type="button" disabled={!edit} onClick={() => setRows(rows.filter((_, at) => at !== index))}>
                              {tr('빼기')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length === 0 && <p className="hint">{tr('아직 외부 번호가 없습니다.')}</p>}
            {edit && (
              <div className="row-buttons">
                <button
                  type="button"
                  onClick={() => setRows([...rows, { subjectKind: 'asset', globalAssetId: asset, key: '', system: '', type: 'equipment', id: '', publish: false, sensitive: false, externalSubjectId: '' }])}
                >
                  {tr('번호 더하기')}
                </button>
                <button type="button" className="primary" onClick={() => void save()}>
                  {tr('외부 번호 저장')}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {edit && <RefImport onApplied={() => setGeneration((value) => value + 1)} />}
    </div>
  );
}

/** CSV import — always a dry run first; "apply" is offered only for a run without errors and conflicts */
function RefImport({ onApplied }: { onApplied: () => void }): React.JSX.Element {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ dryRun: boolean; rejected?: boolean; value: RefImportResult }>();
  const [error, setError] = useState<unknown>();

  const run = async (dryRun: boolean): Promise<void> => {
    setError(undefined);
    try {
      const value = await integrationApi.importExternalRefs(csv, dryRun);
      setResult({ dryRun, value });
      if (!dryRun) onApplied();
    } catch (caught) {
      // The data changed between the dry run and the apply — the server refused it whole, show its report
      const rejected = rejectedImportOf(caught);
      if (rejected) setResult({ dryRun: false, rejected: true, value: rejected });
      else setError(caught);
    }
  };
  const clean = result?.dryRun === true && result.value.errors.length === 0 && result.value.conflicts.length === 0;
  const changed = result?.value.changes.reduce((sum, change) => sum + change.add.length + change.remove.length, 0) ?? 0;

  return (
    <section>
      <h3>{tr('CSV 로 한꺼번에 넣기')}</h3>
      <p className="hint mono">globalAssetId,subjectKind,subjectKey,system,type,id,publish,sensitive,externalSubjectId</p>
      <p className="hint">{tr('globalAssetId 로 파일을 찾습니다. 파일에 적힌 번호만 더하거나 고치고, 다른 번호는 지우지 않습니다.')}</p>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label={tr('CSV 파일 고르기')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void file.text().then((text) => setCsv(text));
        }}
      />
      <textarea aria-label={tr('CSV 내용')} value={csv} onChange={(event) => setCsv(event.target.value)} />
      <div className="row-buttons">
        <button type="button" disabled={csv.trim() === ''} onClick={() => void run(true)}>
          {tr('미리 보기')}
        </button>
        <button type="button" className="primary" disabled={!clean || changed === 0} onClick={() => void run(false)}>
          {tr('적용')}
        </button>
      </div>
      <ErrorNote error={error} />
      {result && (
        <div className="import-result">
          <p className={result.value.errors.length + result.value.conflicts.length > 0 ? 'note error' : 'note ok'}>
            {fill(result.dryRun ? tr('미리 보기 — 바뀔 번호 {0}개 · 오류 {1}줄 · 충돌 {2}건') : result.rejected ? tr('적용하지 않았습니다 — 바뀔 번호 {0}개 · 오류 {1}줄 · 충돌 {2}건이 있어 아무것도 바꾸지 않았습니다') : tr('적용했습니다 — 바뀐 번호 {0}개 · 오류 {1}줄 · 충돌 {2}건'), {
              0: changed,
              1: result.value.errors.length,
              2: result.value.conflicts.length,
            })}
          </p>
          <ul>
            {result.value.changes.map((change) => (
              <li key={change.packageId} className="mono">
                {change.packageId}: +{change.add.map((ref) => `${ref.system}|${ref.type}|${ref.id}`).join(', ')}
                {change.remove.length > 0 ? ` −${change.remove.map((ref) => `${ref.system}|${ref.type}|${ref.id}`).join(', ')}` : ''}
              </li>
            ))}
            {result.value.errors.map((item) => (
              <li key={`e-${item.row}-${item.message}`} className="error">
                {fill(tr('{0}번째 줄: {1}'), { 0: item.row, 1: item.message })}
              </li>
            ))}
          </ul>
          <Claims claims={result.value.conflicts} />
        </div>
      )}
    </section>
  );
}
