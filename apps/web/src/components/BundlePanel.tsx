/**
 * 레퍼런스 번들 — 공정 파일 하나를 「제출 꾸러미 한 벌」로 보는 화면.
 *
 * 평가자가 묻는 세 가지에 한 화면으로 답한다(레퍼런스번들_추진방안 §2.3).
 *  ① 무엇이 들었나 — 공정 → 설비 구성과 설비마다 파일·버전·사전 점검
 *  ② 이어지나 — 공정 KPI의 재료(운전 데이터)를 설비들이 함께 갖고 있는가 (공통 항목 매트릭스)
 *  ③ 믿을 수 있나 — 내보낼 때 파일마다 SHA256을 manifest에 박는다
 * 그리고 두 가지를 더 지킨다(2026-09-30 검증 후 보완).
 *  ④ 시연 대신 — 수집 기록(실동작 증빙)을 싣고, 번들을 다시 열어도 이어받는다
 *  ⑤ 사람이 넣은 문서 — 여기서 올린 Use-Case·가이던스·참고 자료는 번들을 열었다 다시 내보내도 남는다
 *
 * 🔴 도구가 문서를 쓰지 않는다. 동의어도 추측하지 않는다 — semanticId가 같은데 이름이 다르거나,
 *    이름이 같은데 semanticId가 다르면 「확인할 점」으로 보여 주고 판단은 사람이 한다.
 * 🔴 KOSMO Validator는 **장비별 AASX를 만들 때** 받는 검증이다 — 번들에는 공식 검증기가 없다(추진방안 §2.3).
 *    여기 ✓는 번들에 넣은 모델을 이 도구가 다시 확인한 참고 표시다. 「번들도 Validator로 판정받는다」처럼
 *    읽히게 쓰지 않는다(사용자 2026-09-30 지적).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type BundleMemberView, type BundleView, type LinkageItemView } from '../api.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

interface Props {
  packageId: string;
  onOpenPackage: (packageId: string) => void;
  onClose: () => void;
}

/** 공통 항목만 볼지 — 번들의 핵심은 「2대 이상이 함께 가진 것」이다 */
type Scope = 'common' | 'all';

const shortSemantic = (id: string): string => {
  const kosmo = /\/ids\/cd\/([^/]+)\//.exec(id)?.[1];
  if (kosmo) return `KOSMO · ${kosmo}`;
  if (/^0173-1#/.test(id)) return `ECLASS · ${id}`;
  return id.length > 40 ? `…${id.slice(-38)}` : id;
};

/** 그룹 경로별로 묶는다 — 화면이 「공정 → 설비」로 읽히게 */
function byGroup(members: BundleMemberView[]): [string, BundleMemberView[]][] {
  const groups = new Map<string, BundleMemberView[]>();
  for (const member of members) {
    const key = member.groupPath.join(' › ');
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  return [...groups.entries()];
}

export function BundlePanel({ packageId, onOpenPackage, onClose }: Props): React.JSX.Element {
  const [view, setView] = useState<BundleView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('RB01');
  const [title, setTitle] = useState('');
  const [version, setVersion] = useState('1.0.0');
  /** 증빙 수준 — auto면 서버가 제안(시뮬레이션뿐일 때만 C) */
  const [evidenceLevel, setEvidenceLevel] = useState('auto');
  const [scope, setScope] = useState<Scope>('common');
  const [focus, setFocus] = useState<string>();
  /** 증빙 기간 — 비우면 전부. 시험하며 쌓인 잡음을 뺄 때 */
  const [evidenceMinutes, setEvidenceMinutes] = useState('');
  /** 첨부를 올리거나 지운 뒤 다시 읽는다 */
  const [tick, setTick] = useState(0);
  /** 첨부 작업의 오류 — 화면 전체를 오류로 바꾸지 않는다 */
  const [note, setNote] = useState<string>();
  // i18n-ignore — 화면 글자가 아니라 **번들 ZIP 안의 폴더 이름**이다. 옮기면 서버가 모르는 폴더가 된다
  const [uploadFolder, setUploadFolder] = useState('01_UseCase문서');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .bundle(packageId, evidenceMinutes)
      .then((result) => alive && setView(result))
      .catch((reason: Error) => alive && setError(reason.message));
    return () => {
      alive = false;
    };
  }, [packageId, evidenceMinutes, tick]);

  const columns = view?.linkage.members ?? [];
  const rows: LinkageItemView[] = useMemo(() => {
    const items = view?.linkage.items ?? [];
    return scope === 'common' ? items.filter((item) => item.coverage >= 2) : items;
  }, [view, scope]);

  /**
   * 설비 → (이름 → 그 이름이 쓰는 semanticId들). 「없다」와 「같은 이름이 다른 semanticId로 있다」를
   * 구분하려고 둔다 — 빈칸으로 두면 평가자는 「그 설비에는 가동상태가 없다」로 읽는다(FDS 실측)
   */
  const namesByMember = useMemo(() => {
    const index = new Map<string, Map<string, Set<string>>>();
    for (const item of view?.linkage.items ?? []) {
      for (const [member, points] of Object.entries(item.points)) {
        const names = index.get(member) ?? new Map<string, Set<string>>();
        for (const point of points) {
          const ids = names.get(point.idShort) ?? new Set<string>();
          ids.add(item.semanticId);
          names.set(point.idShort, ids);
        }
        index.set(member, names);
      }
    }
    return index;
  }, [view]);

  /** 확인할 점이 걸린 semanticId — 매트릭스 줄에 ⚠ 표시 */
  const flagged = useMemo(() => {
    const map = new Map<string, 'warning' | 'info'>();
    for (const finding of view?.linkage.findings ?? []) {
      for (const id of finding.semanticIds) {
        if (map.get(id) !== 'warning') map.set(id, finding.severity);
      }
    }
    return map;
  }, [view]);

  if (error) {
    return (
      <div className="modal-back" onClick={onClose}>
        <div className="modal" onClick={(event) => event.stopPropagation()}>
          <button className="link modal-close" onClick={onClose}>{tr('닫기')}</button>
          <div className="bundle-body">
            <h2>{tr('레퍼런스 번들')}</h2>
            <p className="error-text">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const members = view?.members ?? [];
  const ready = members.filter((m) => m.packageId);
  const planned = members.filter((m) => !m.packageId);
  const failing = ready.filter((m) => m.lint && !m.lint.passed);
  const common = (view?.linkage.items ?? []).filter((item) => item.coverage >= 2).length;
  const warnings = (view?.linkage.findings ?? []).filter((f) => f.severity === 'warning').length;
  const category = view?.categories[code] ?? '';
  const demos = ready.filter((m) => m.demo);
  const evidence = view?.evidence;
  const carried = (evidence?.sources.length ?? 0) === 0 ? evidence?.carried : undefined;
  const shownSources = (evidence?.sources.length ?? 0) > 0 ? evidence!.sources : (carried?.entries ?? []);
  const samples = shownSources.reduce((sum, source) => sum + source.samples, 0);
  const effectiveLevel =
    evidenceLevel === 'auto'
      ? (evidence?.suggested ?? carried?.level ?? null)
      : evidenceLevel === 'none'
        ? null
        : evidenceLevel;
  const attachments = view?.attachments ?? [];
  const aasd120 = ready.reduce((sum, m) => sum + (m.lint?.aasd120 ?? 0), 0);

  const onUpload = async (file: File): Promise<void> => {
    setNote(undefined);
    try {
      await api.putBundleFile(packageId, `${uploadFolder}/${file.name}`, file);
      setNote(fill(tr('「{0}」을(를) {1}에 넣었습니다 — 번들을 다시 열어도 남습니다.'), { 0: file.name, 1: uploadFolder }));
      setTick((n) => n + 1);
    } catch (reason) {
      setNote(`⚠ ${(reason as Error).message}`);
    }
  };
  const onRemove = async (path: string): Promise<void> => {
    if (!globalThis.confirm(fill(tr('{0}\n\n번들 첨부에서 지웁니다. 계속할까요?'), { 0: path }))) return;
    setNote(undefined);
    try {
      await api.deleteBundleFile(packageId, path);
      setTick((n) => n + 1);
    } catch (reason) {
      setNote(`⚠ ${(reason as Error).message}`);
    }
  };
  const stamp = (iso: string): string =>
    new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.downloadBundle(packageId, {
        code,
        title: title.trim() || category,
        version,
        evidence: evidenceLevel,
        evidenceMinutes,
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <button className="link modal-close" onClick={onClose}>{tr('닫기')}</button>
        <div className="bundle-body">
          <h2><T k={'레퍼런스 번들 {0}'} v={[<span className="dim">— {view?.process.name ?? tr('읽는 중…')}</span>]} />
          </h2>

          {/* 내보내기 — 한 화면에 파란 버튼은 하나 */}
          <div className="bundle-form">
            <label>
              {tr('번들')}
              <select value={code} onChange={(event) => setCode(event.target.value)}>
                {Object.entries(view?.categories ?? { RB01: '' }).map(([key, name]) => (
                  <option key={key} value={key}>
                    {key} {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              {tr('제목')}
              <input value={title} placeholder={category} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              {tr('버전')}
              <input className="narrow" value={version} onChange={(event) => setVersion(event.target.value)} />
            </label>
            <label title={tr('수집 기록이 어디서 왔는지 — 기록서·README·manifest에 찍힙니다')}>
              {tr('증빙 수준')}
              <select value={evidenceLevel} onChange={(event) => setEvidenceLevel(event.target.value)}>
                {/* <option> 안에는 글자만 둔다 — 화면 요소를 넣으면 브라우저가 글자로 읽지 못한다 */}
                <option value="auto">
                  {fill(tr('자동 ({0})'), {
                    0: evidence?.suggested ?? (evidence?.sources.length ? null : evidence?.carried?.level) ?? tr('미지정'),
                  })}
                </option>
                <option value="A">{tr('A 현장 적용')}</option>
                <option value="B">{tr('B 실장비 재현')}</option>
                <option value="C">{tr('C 시뮬레이션')}</option>
                <option value="none">{tr('비움')}</option>
              </select>
            </label>
            <label title={tr('어느 기간의 수집값을 실을지 — 시험 중 쌓인 값을 빼고 싶을 때')}>
              {tr('증빙 기간')}
              <select value={evidenceMinutes} onChange={(event) => setEvidenceMinutes(event.target.value)}>
                <option value="">{tr('전부')}</option>
                <option value="10">{tr('최근 10분')}</option>
                <option value="30">{tr('최근 30분')}</option>
                <option value="60">{tr('최근 1시간')}</option>
                <option value="1440">{tr('최근 24시간')}</option>
              </select>
            </label>
            <button
              className="primary"
              disabled={busy || !view || ready.length === 0}
              onClick={() => void onExport()}
              title={tr('공정 구성 + 설비 AASX + manifest(SHA256) + 폴더 골격을 ZIP 하나로 받습니다')}
            >
              {busy ? tr('만드는 중…') : tr('번들 내보내기 (.zip)')}
            </button>
          </div>

          {demos.length > 0 && (
            <p className="bundle-demo-note"><T k={'⚡ <b>시연본 {0}대 포함</b> — 수집 연결(AID)이 붙어 있습니다. 시연용으로는 맞지만,<b> 정식 번들</b>에는 연결이 없는 원본 참조모델을 넣으십시오. 내보내면 README와 manifest에도 표시됩니다.'} v={[demos.length]} /></p>
          )}

          {/* 한눈에 — 숫자 넷 */}
          <div className="bundle-stats">
            <div className="stat">
              <span className="num">{members.length}</span>
              <span className="label">{tr('설비')}</span>
              <span className="sub"><T k={'파일 {0}{1}'} v={[ready.length, planned.length > 0 && <> · <b className="warn-text"><T k={'예정 {0}'} v={[planned.length]} /></b></>]} />
              </span>
            </div>
            <div className={`stat ${failing.length > 0 ? 'bad' : 'ok'}`}>
              <span className="num">{failing.length === 0 ? '✓' : failing.length}</span>
              <span className="label">{tr('사전 점검')}</span>
              <span className="sub">
                {failing.length === 0 ? tr('위반 0건') : tr('위반 있는 설비')}
                {aasd120 > 0 && (
                  <>
                    {' · '}
                    <b className="warn-text" title={tr('KOSMO는 검사하지 않지만 표준 검증기(aas-test-engines)는 오류로 보고, BaSyx는 그 하위를 버립니다')}><T k={'표준 AASd-120 {0}'} v={[aasd120]} />
                    </b>
                  </>
                )}
              </span>
            </div>
            <div className="stat">
              <span className="num">{common}</span>
              <span className="label">{tr('공통 항목')}</span>
              <span className="sub">{tr('2대 이상이 함께 가진 운전 데이터')}</span>
            </div>
            <div className={`stat ${warnings > 0 ? 'warn' : 'ok'}`}>
              <span className="num">{warnings}</span>
              <span className="label">{tr('확인할 점')}</span>
              <span className="sub">{tr('semanticId 재사용')}</span>
            </div>
            <div className={`stat ${samples > 0 ? 'ok' : 'warn'}`}>
              <span className="num">{samples > 0 ? samples.toLocaleString('ko-KR') : '—'}</span>
              <span className="label">{tr('실동작 증빙')}</span>
              <span className="sub">
                {samples > 0
                  ? fill(tr('{0} · 수준 {1}'), { 0: carried ? tr('이어받은 기록') : tr('수집 기록'), 1: effectiveLevel ?? tr('미지정') })
                  : tr('수집 기록 없음')}
              </span>
            </div>
          </div>

          {/* ① 구성과 준비 상태 */}
          <h3>{tr('① 구성과 준비 상태')}</h3>
          {!view && <p className="dim">{tr('읽는 중…')}</p>}
          {view && members.length === 0 && (
            <p className="dim">{tr('이 공정에 아직 설비가 없습니다. 「무엇으로 이루어졌나」에서 설비를 넣으십시오.')}</p>
          )}
          {byGroup(members).map(([group, list]) => (
            <div key={group || tr('(최상위)')} className="bundle-group">
              <div className="bundle-group-name">▦ {group || view?.process.name}</div>
              <div className="bundle-cards">
                {list.map((member, index) => (
                  <button
                    key={`${member.name}-${index}`}
                    className={`bundle-card ${member.packageId ? (member.lint?.passed ? 'ok' : 'bad') : 'planned'}`}
                    disabled={!member.packageId}
                    onClick={() => member.packageId && onOpenPackage(member.packageId)}
                    title={member.packageId ? tr('눌러서 이 설비 파일을 엽니다') : tr('파일이 없습니다 — 같은 이름으로 설비 파일을 만들면 이어집니다')}
                  >
                    <span className="card-name">
                      ⚙ {member.name}
                      {member.bulkCount > 1 && <span className="dim"> ×{member.bulkCount}</span>}
                    </span>
                    <span className="card-file">{member.fileName ?? tr('파일 없음')}</span>
                    {member.demo && (
                      <span className="card-demo" title={tr('수집 연결(AID)이 붙은 시연본입니다 — 정식 번들에는 원본 참조모델을 넣으십시오')}>
                        {tr('⚡ 수집 연결 · 시연본')}
                      </span>
                    )}
                    {(member.lint?.aasd120 ?? 0) > 0 && (
                      <span
                        className="card-std"
                        title={tr('SubmodelElementList 자식에 idShort — KOSMO는 통과지만 표준 검증기는 오류, BaSyx는 그 하위를 버립니다. 설비 파일을 열어 「자동 고치기」로 지우면 KOSMO에도 영향 없이 풀립니다')}
                      ><T k={'표준 AASd-120 {0}'} v={[member.lint!.aasd120]} />
                      </span>
                    )}
                    <span className="card-state">
                      {!member.packageId && tr('예정')}
                      {member.lint && (member.lint.passed ? fill(tr('✓ 통과 · 경고 {0}'), { 0: member.lint.warning }) : fill(tr('✕ 위반 {0}'), { 0: member.lint.error }))}
                      {member.version && <span className="dim"> · v{member.version}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* ② 데이터 연계 */}
          <h3><T k={'② 데이터 연계 — 운전 데이터 공통 항목{0}'} v={[<span className="seg">
              <button
              className={scope === 'common' ? 'on' : ''}
              title={tr('설비 둘 이상이 함께 가진 항목만 봅니다 — 연계에 쓸 수 있는 것들입니다')}
              onClick={() => setScope('common')}
            ><T k={'2대 이상 공통 ({0})'} v={[common]} /></button>
              <button
              className={scope === 'all' ? 'on' : ''}
              title={tr('설비 하나에만 있는 항목까지 모두 봅니다')}
              onClick={() => setScope('all')}
            ><T k={'전부 ({0})'} v={[view?.linkage.items.length ?? 0]} /></button>
            </span>]} />
          </h3>
          <p className="dim small"><T k={'OperationalData의 항목을 <b>semanticId</b>로 묶었습니다. 공정 KPI(OEE·에너지 원단위 등)는 여러 설비의 같은 항목을 모아야 나옵니다. 칸에 마우스를 올리면 그 설비 안의 경로가 보입니다.'} /></p>
          {columns.length === 0 ? (
            <p className="dim">{tr('열린 설비 파일이 없어 분석할 수 없습니다.')}</p>
          ) : rows.length === 0 && columns.length === 1 ? (
            <p className="dim"><T k={'설비가 <b>1대</b>라 「공통」 항목이 생길 수 없습니다 — 연계는 설비 2대 이상부터 봅니다(계획서: 공정당 3~5대). 「전부」로 이 설비의 운전 데이터 {0}개를 보십시오.'} v={[view?.linkage.items.length ?? 0]} /></p>
          ) : rows.length === 0 ? (
            <p className="dim">{tr('2대 이상이 함께 가진 항목이 없습니다 — 「전부」로 설비별 항목을 보십시오.')}</p>
          ) : (
            <div className="matrix-wrap">
              <table className="matrix">
                <thead>
                  <tr>
                    <th className="item-col">{tr('항목 (semanticId)')}</th>
                    <th className="cov-col">{tr('보유')}</th>
                    {columns.map((name) => (
                      <th key={name} className="member-col" title={name}>
                        <span>{name}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const flag = flagged.get(item.semanticId);
                    return (
                      <tr
                        key={item.semanticId}
                        className={focus === item.semanticId ? 'focus' : ''}
                        onMouseEnter={() => setFocus(item.semanticId)}
                        onMouseLeave={() => setFocus(undefined)}
                      >
                        <td className="item-col" title={item.semanticId}>
                          {flag && <span className={`flag ${flag}`} title={tr('확인할 점이 있습니다 — 아래 목록')}>{flag === 'warning' ? '⚠' : 'ℹ'}</span>}
                          <b>{item.label}</b>
                          {item.unit && <span className="dim"> [{item.unit}]</span>}
                          {item.names.length > 1 && <span className="warn-text">{' '}<T k={'외 {0}'} v={[item.names.slice(1).join(', ')]} /></span>}
                          <div className="sem">{shortSemantic(item.semanticId)}</div>
                        </td>
                        <td className="cov-col">
                          <div className="cov-bar" aria-label={fill(tr('{0}/{1}대'), { 0: item.coverage, 1: columns.length })}>
                            <span style={{ width: `${(item.coverage / columns.length) * 100}%` }} />
                          </div>
                          <span className="cov-num">
                            {item.coverage}/{columns.length}
                          </span>
                        </td>
                        {columns.map((name) => {
                          const points = item.points[name] ?? [];
                          const other = points.some((p) => p.idShort !== item.label);
                          // 이 줄엔 없지만 같은 이름이 다른 semanticId로 있는가
                          const elsewhere =
                            points.length === 0
                              ? [...(namesByMember.get(name)?.get(item.label) ?? [])].filter((id) => id !== item.semanticId)
                              : [];
                          if (elsewhere.length > 0) {
                            return (
                              <td
                                key={name}
                                className="cell split"
                                title={fill(tr('같은 이름 {0}이(가) 다른 semanticId로 있습니다 — 그대로는 모이지 않습니다\n{1}'), { 0: item.label, 1: elsewhere.join('\n') })}
                              >
                                ≠
                              </td>
                            );
                          }
                          return (
                            <td
                              key={name}
                              className={`cell ${points.length > 0 ? (other ? 'has other' : 'has') : ''}`}
                              title={points.map((p) => `${p.path}${p.valueType ? ` (${p.valueType})` : ''}`).join('\n') || tr('없음')}
                            >
                              {points.length > 0 ? (points.length > 1 ? points.length : '●') : ''}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="dim small legend">
                <T k={'{0} 같은 이름으로 있음 · {1} 다른 이름으로 있음 · {2} 같은 이름이 <b>다른 semanticId</b>로 있음(그대로는 안 모임) · 숫자는 한 설비 안의 자리 수'} v={[<span className="cell-demo has">●</span>, <span className="cell-demo has other">●</span>, <span className="cell-demo split">≠</span>]} /></p>
            </div>
          )}

          {/* ③ 실동작 증빙 — 시연을 못 하는 제출 자리에서 시연을 대신한다 */}
          <h3>{tr('③ 실동작 증빙 — 수집 기록')}</h3>
          {shownSources.length === 0 ? (
            <div className="evidence-empty">
              <b>{tr('아직 수집 기록이 없습니다.')}</b> {tr('이대로 내보내면 번들에 「실제로 값이 흘렀다」는 증빙이 빠집니다.')}
              <ol>
                <li>{tr('이 번들의 설비를 「호기별로 나누기」로 복제하거나, 시연용 번들(호기 파일)을 함께 엽니다')}</li>
                <li>{tr('가상 PLC(또는 현장 PLC)에 수집 연결을 만들고 몇 분 수집합니다 — 자동 수집이면 더 좋습니다')}</li>
                <li><T k={'다시 이 화면에서 내보내면 <code>05_샘플데이터/수집값_*.csv</code>와 <code>06_검증결과/수집기록.html</code>이 실립니다'} /></li>
              </ol>
            </div>
          ) : (
            <>
              {carried ? (
                <p className="bundle-demo-note"><T k={'↩ 이번에 새로 모은 값은 없습니다 — 번들을 열 때 가져온 <b>이전 번들({0} v{1})의 수집 기록</b>을 그대로 이어받아 싣습니다. 새로 수집하면 통째로 새 기록으로 바뀝니다.'} v={[carried.from.code, carried.from.version]} /></p>
              ) : (
                <p className="dim small"><T k={'번들의 형식 모델은 그대로 두고, <b>그 설비나 거기서 파생된 호기(derivedFrom)</b>에 쌓인 값을 별도 파일로 싣습니다. 현장 주소는 공개 번들이라 가려서 싣습니다.'} /></p>
              )}
              <div className="evidence-list">
                {shownSources.map((source) => (
                  <div key={`${source.model}-${source.instance}`} className={`evidence-card ${carried ? 'carried' : ''}`}>
                    <div className="ev-head">
                      <b>{source.model}</b>
                      {!source.direct && <span className="dim"> ← {source.instance}</span>}
                      {carried && <span className="ev-carried">{tr('이어받음')}</span>}
                      {source.interfaces.some((i) => i.simulated) && <span className="ev-sim">{tr('시뮬레이션')}</span>}
                    </div>
                    <div className="ev-num">
                      {source.samples.toLocaleString('ko-KR')}
                      <span><T k={'건 · 항목 {0}'} v={[source.properties]} /></span>
                    </div>
                    <div className="dim small">
                      {stamp(source.from)} ~ {stamp(source.to)}
                    </div>
                    {source.interfaces.map((iface) => (
                      <div key={iface.title + iface.endpoint} className="ev-iface">
                        {iface.title} <code>{iface.endpoint}</code>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ④ 사람이 넣은 문서 — 번들을 다시 열어도 남는다 */}
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

          {/* ⑤ 확인할 점 */}
          <h3>{tr('⑤ 확인할 점')}</h3>
          {(view?.linkage.findings.length ?? 0) === 0 ? (
            <p className="dim">{tr('없음')}</p>
          ) : (
            <ul className="bundle-findings">
              {view!.linkage.findings.map((finding, index) => (
                <li
                  key={index}
                  className={finding.severity}
                  onMouseEnter={() => setFocus(finding.semanticIds[0])}
                  onMouseLeave={() => setFocus(undefined)}
                >
                  <span className="badge">{finding.severity === 'warning' ? tr('⚠ 확인') : tr('ℹ 참고')}</span> {finding.message}
                </li>
              ))}
            </ul>
          )}

          <p className="dim small bundle-foot"><T k={'내보낸 ZIP: <code>00_공정구성 · 01_UseCase문서 · 02_참조모델 · 03_가이던스 · 04_데이터연계정의 · 05_샘플데이터 · 06_검증결과</code>+ <code>bundle-manifest.json</code>(파일마다 SHA256) + <code>README.md</code>. 문서는 작성 안내만 들어갑니다.<br/>✓ 사전 점검은 번들에 넣은 모델을 이 도구가 <b>다시 확인한 참고 표시</b>입니다. 모델의 공식 검증(KOSMO Validator)은 장비별 AASX를 만들 때 받는 것이라 번들에서 따로 하지 않습니다 — 번들 자체의 확인은 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 합니다.'} /></p>
        </div>
      </div>
    </div>
  );
}
