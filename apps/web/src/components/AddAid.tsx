/**
 * 수집 연결 만들기 — 접속 주소와 태그로 AID 서브모델(IDTA-02017)을 짓는다.
 *
 * 🔴 **두 걸음으로 줄였다**(2026-09-01 사용자 지적: "너무 어렵고 다 입력해야 하는지 모르겠다").
 *    전에는 칸이 7개(이름·NodeId·PLC주소·타입·단위·대분류·소분류)나 한꺼번에 보여서
 *    무엇이 필수인지 알 수 없었고, 좁은 칸에서 글자가 잘려 나갔다.
 *      ① 설비 주소 → 불러오기    ② 태그 고르기 → 만들기
 *    선택 항목(PLC 주소·단위)은 **없앴다.** AID 규격에서 선택이고, 훑어 오면 어차피 안 채워진다.
 *    자리 만들기 설정은 「자세히」 안으로 접었다 — 기본값이 맞는 사람이 대부분이다.
 * 🔴 팝업으로 띄운다. 오른쪽 칸에 끼워 넣으면 폭이 모자라 형태가 무너진다(실측).
 */
import { useState } from 'react';
import { api } from '../api.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

interface Props {
  packageId: string;
  /** 모델의 잎 요소 idShort — 이름을 여기 맞추면 live 내보내기가 된다 */
  leafNames: readonly string[];
  busy: boolean;
  /**
   * 이 도구가 값을 **내주는** 주소(M6·M7). 있으면 그 주소를 여기 넣는 것을 막는다 —
   * 손으로 붙여 넣는 길은 서버 차단(409)에 닿기 전에 잡는 편이 친절하다.
   */
  outEndpoint?: string;
  onCancel: () => void;
  onDone: (summary: string) => void;
}

interface TagRow {
  name: string;
  href: string;
  type: string;
}

const EMPTY: TagRow = { name: '', href: '', type: 'float' };

/** 요소 이름으로 쓸 수 있게 다듬는다 — 안 그러면 「만들기」에서 막힌다 */
function asElementName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z])/, 'T$1');
}

export function AddAid({ packageId, leafNames, busy, outEndpoint, onCancel, onDone }: Props): React.JSX.Element {
  const [endpoint, setEndpoint] = useState('opc.tcp://');
  const [rows, setRows] = useState<TagRow[]>([]);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [manual, setManual] = useState(false);

  /** 설비에서 훑어 온 태그 — NodeId를 손으로 치지 않게 하는 자리 */
  const [found, setFound] = useState<Awaited<ReturnType<typeof api.browseDevice>>>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [browsing, setBrowsing] = useState(false);

  // 자리 만들기 — 기본값이 맞는 사람이 대부분이라 접어 둔다
  const [makeElements, setMakeElements] = useState(true);
  const [group, setGroup] = useState('ProcessMonitoring');
  const [subgroup, setSubgroup] = useState('CollectedValues');

  /** 🔴 우리가 내주는 주소를 그대로 넣었는가 — 실제로 났던 사고다 */
  const isOurOwn =
    outEndpoint !== undefined && endpoint.trim() !== '' && endpoint.trim() === outEndpoint.trim();

  const filled = rows.filter((row) => row.name.trim() !== '' && row.href.trim() !== '');
  const misses = filled.filter((row) => !leafNames.includes(row.name.trim())).length;

  const browse = async (): Promise<void> => {
    setBrowsing(true);
    setError(undefined);
    try {
      setFound(await api.browseDevice(endpoint.trim()));
      setPicked(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBrowsing(false);
    }
  };

  /** 고른 것을 태그로 담는다 — 이름은 browseName, 주소는 NodeId 그대로 */
  const applyPicked = (): void => {
    const chosen = (found?.nodes ?? []).filter((node) => picked.has(node.nodeId));
    const already = new Set(rows.map((row) => row.href));
    setRows([
      ...rows.filter((row) => row.name.trim() !== '' || row.href.trim() !== ''),
      ...chosen
        .filter((node) => !already.has(node.nodeId))
        .map((node) => ({ name: asElementName(node.name), href: node.nodeId, type: node.type })),
    ]);
    setFound(undefined);
  };

  const create = async (): Promise<void> => {
    setWorking(true);
    setError(undefined);
    try {
      const result = await api.createAid(packageId, {
        endpoint: endpoint.trim(),
        tags: filled.map((row) => ({ name: row.name.trim(), href: row.href.trim(), type: row.type })),
        ...(makeElements ? { createMissing: { group: group.trim(), subgroup: subgroup.trim() } } : {}),
      });
      // 🔴 알림 띠는 한 줄이다 — 세 문장을 이어 붙이니 200자가 넘어 아무도 안 읽었다(시연 실측).
      //    좋은 소식은 짧게, 나쁜 소식(못 만든 것·안 맞는 이름)만 붙인다. 자세한 것은 오른쪽 표가 보여 준다
      const made = result.elementsAdded?.length > 0 ? fill(tr(' · 요소 {0}개 새로 세움'), { 0: result.elementsAdded.length }) : '';
      /* elementsConflicted = 다른 서브모델에 같은 이름이 **이미 있어** 자리를 새로 안 판 것.
         태그 이름을 모델 요소(예: Nameplate/SerialNumber)에 맞춘 정상 경로라 경고가 아니다 —
         예전엔 ⚠로 띄워 "왜 안 생겼지"가 됐다(시연 실측). 값은 그 기존 요소에 얹힌다 */
      const conflicted = result.elementsConflicted ?? [];
      const clash =
        conflicted.length > 0 ? fill(tr(' · 모델에 이미 있어 그대로 연결: {0}'), { 0: conflicted.join(', ') }) : '';
      const misses =
        result.nameMisses.length > 0
          ? fill(tr(' · ⚠ 모델과 이름이 안 맞는 태그 {0}개(표의 「모델연결」 열 참조)'), { 0: result.nameMisses.length })
          : '';
      onDone(fill(tr('수집 연결을 {0}{1}{2}{3}'), { 0: result.replaced ? tr('바꿨습니다') : tr('만들었습니다'), 1: made, 2: clash, 3: misses }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="modal-back" role="presentation" onClick={onCancel}>
      <div
        className="modal add-aid"
        role="dialog"
        aria-modal="true"
        aria-label={tr('수집 연결 만들기')}
        onClick={(event) => event.stopPropagation()}
      >
        <button className="link modal-close" aria-label={tr('수집 연결 닫기')} onClick={onCancel}>
          {tr('닫기 ✕')}
        </button>
        <h3>{tr('← 수집 연결 만들기 — 설비에서 받아 오기')}</h3>
        {/* 🔴 방향 그림. 「주소」가 두 종류라 무엇을 설정하는 중인지 못박아야 한다 */}
        <p className="flow">
          <T k={'<b>{0}</b> ──▶ [이 도구] ──▶ [MES·SCADA]{1}'} v={[tr('[설비·PLC]'), <span className="here">{tr('↑ 지금 여기를 설정합니다')}</span>]} />
        </p>
        <p className="hint"><T k={'설비에 붙어 태그를 고르면 <b>AID 서브모델</b>(IDTA-02017)을 규격대로 만듭니다.'} /></p>

        {/* ── ① 설비 주소 ───────────────────────────────────── */}
        <section className="step">
          <h4>
            <T k={'{0} 설비(PLC)의 OPC UA 주소{1}'} v={[<span className="num">1</span>, <span className="count dim">{tr('내가 접속하러 갈 곳')}</span>]} />
          </h4>
          <div className="step-line">
            <input
              value={endpoint}
              className="mono"
              aria-label={tr('접속 주소')}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="opc.tcp://192.168.0.50:4840"
            />
            <button
              className="primary"
              title={tr('그 주소에 붙어 설비가 내주는 태그 목록을 읽어 옵니다 — 값을 바꾸지 않습니다')}
              onClick={() => void browse()}
              disabled={browsing || isOurOwn || !/^opc\.tcp:\/\/.+/.test(endpoint.trim())}
            >
              {browsing ? tr('훑는 중…') : tr('설비에서 불러오기')}
            </button>
          </div>
          {isOurOwn && (
            <p className="note warn self-warn">
              <T k={'<b>여기는 설비가 아니라 이 도구 자신입니다.</b> 이 주소는 우리가 상위 앱(MES·SCADA)에 값을 <b>내주는</b> 주소입니다 — 여기서 보이는 것은 설비 태그가 아니라 열려 있는 AAS 파일의 내용(제조사명·일련번호 같은 명판 정보)입니다.<br/>수집할 곳은 <b>설비(PLC)의 주소</b>입니다. 예: {0}<br/>장비 없이 시험만 해 보려면 가상 PLC를 띄우십시오 — {1}'} v={[<span className="mono">opc.tcp://192.168.0.50:4840</span>, <span className="mono">node scripts/plc-simulator.mjs</span>]} />
            </p>
          )}
        </section>

        {/* ── ② 태그 고르기 ─────────────────────────────────── */}
        <section className="step">
          <h4>
            <T k={'{0} 수집할 태그{1}'} v={[<span className="num">2</span>, filled.length > 0 && <span className="count"><T k={'{0}개 담김'} v={[filled.length]} /></span>]} />
          </h4>

          {found && (
            <div className="browsed">
              <div className="browsed-head">
                <b><T k={'태그 {0}개'} v={[found.nodes.length]} /></b>
                {found.truncated && <span className="warn"> {tr('· 너무 많아 일부만')}</span>}
                <span className="spacer" />
                <button
                  className="link"
                  title={tr('훑어 온 태그를 모두 고릅니다')}
                  onClick={() => setPicked(new Set(found.nodes.map((node) => node.nodeId)))}
                >
                  {tr('전체 선택')}
                </button>
                <button className="link" onClick={() => setFound(undefined)}>
                  {tr('닫기 ✕')}
                </button>
              </div>
              <ul className="browsed-list">
                {found.nodes.map((node) => (
                  <li key={node.nodeId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked.has(node.nodeId)}
                        onChange={(event) => {
                          const next = new Set(picked);
                          if (event.target.checked) next.add(node.nodeId);
                          else next.delete(node.nodeId);
                          setPicked(next);
                        }}
                      />
                      <span className="tag-name">{node.name}</span>
                      <span className="chip">{node.type}</span>
                      {/* 🔴 지금 값 — "이게 그 태그가 맞나"를 고르는 자리에서 확인한다 */}
                      {node.value !== undefined && <span className="now">{node.value}</span>}
                      {node.error && <span className="warn">{node.error}</span>}
                      <div className="mono address">{node.path}</div>
                    </label>
                  </li>
                ))}
              </ul>
              <button
                className="primary"
                disabled={picked.size === 0}
                title={tr('고른 태그를 아래 목록으로 가져옵니다 — 이름·단위는 거기서 고칠 수 있습니다')}
                onClick={applyPicked}
              ><T k={'고른 {0}개 담기'} v={[picked.size]} /></button>
            </div>
          )}

          {!found && rows.length === 0 && !manual && (
            <p className="hint"><T k={'위에 주소를 넣고 <b>「설비에서 불러오기」</b>를 누르면 태그를 골라 담을 수 있습니다.'} /></p>
          )}

          {rows.length > 0 && (
            <ul className="picked-list">
              {rows.map((row, index) => (
                <li key={index}>
                  <input
                    value={row.name}
                    list="leaf-names"
                    aria-label={fill(tr('태그 {0} 이름'), { 0: index + 1 })}
                    className={row.name.trim() !== '' && !leafNames.includes(row.name.trim()) ? 'miss' : ''}
                    onChange={(event) =>
                      setRows(rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)))
                    }
                    placeholder={tr('이름')}
                  />
                  <input
                    value={row.href}
                    className="mono"
                    aria-label={fill(tr('태그 {0} 주소'), { 0: index + 1 })}
                    onChange={(event) =>
                      setRows(rows.map((r, i) => (i === index ? { ...r, href: event.target.value } : r)))
                    }
                    placeholder="NodeId"
                  />
                  <select
                    value={row.type}
                    aria-label={fill(tr('태그 {0} 타입'), { 0: index + 1 })}
                    onChange={(event) =>
                      setRows(rows.map((r, i) => (i === index ? { ...r, type: event.target.value } : r)))
                    }
                  >
                    {['float', 'integer', 'string', 'boolean'].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                  <button
                    className="link"
                    title={tr('이 줄을 뺍니다')}
                    aria-label={fill(tr('태그 {0} 지우기'), { 0: index + 1 })}
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="row-buttons">
            <button
              className="link"
              title={tr('설비에 붙지 않고 태그 주소를 직접 적습니다 — 주소를 이미 아는 경우')}
              onClick={() => {
                setManual(true);
                setRows([...rows, { ...EMPTY }]);
              }}
            >
              {tr('+ 손으로 입력')}
            </button>
            {misses > 0 && (
              <span className="hint warn"><T k={'⚠ {0}개는 모델에 없는 이름 — {1}'} v={[misses, makeElements ? tr('자리를 함께 만듭니다') : tr('값이 밖으로 안 나갑니다')]} />
              </span>
            )}
          </div>
        </section>

        {/* ── 자세히 — 기본값이 맞는 사람이 대부분이라 접어 둔다 ── */}
        <details className="more">
          <summary>{tr('자세히 — 모델에 없는 항목의 자리')}</summary>
          <label className="check-line">
            <input
              type="checkbox"
              checked={makeElements}
              onChange={(event) => setMakeElements(event.target.checked)}
            />
            {tr('모델에 없는 항목의')} <b>{tr('자리도 함께 만들기')}</b>
          </label>
          {makeElements && (
            <>
              <div className="group-line">
                <input value={group} aria-label={tr('대분류')} onChange={(event) => setGroup(event.target.value)} />
                <input
                  value={subgroup}
                  aria-label={tr('소분류')}
                  onChange={(event) => setSubgroup(event.target.value)}
                />
              </div>
              <p className="hint">
                {tr('OperationalData 아래 이 두 칸으로 묶어 만듭니다. 이미 있는 이름은 건드리지 않고, 값 칸에는 예시값이 들어갑니다(규격이 빈 칸을 위반으로 봅니다).')}
              </p>
              {/* 🔴 되돌리기가 없다는 사실은 **만들기 전에** 말해야 한다 */}
              <p className="hint warn"><T k={'⚠ 이렇게 만든 항목은 나중에 <b>「연결삭제」로 지워지지 않습니다.</b> 필요 없어지면 트리에서 직접 지워야 합니다.'} /></p>
            </>
          )}
        </details>

        <datalist id="leaf-names">
          {leafNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        {error && <p className="note error">{error}</p>}
        <div className="row-buttons modal-actions">
          <button
            className="primary"
            disabled={busy || working || isOurOwn || filled.length === 0}
            title={tr('적은 주소와 태그로 AID 서브모델(IDTA-02017)을 규격대로 만듭니다 — 이미 있으면 바꿔치웁니다')}
            onClick={() => void create()}
          >
            {working ? tr('만드는 중…') : fill(tr('만들기{0}'), { 0: filled.length > 0 ? fill(tr(' ({0}개)'), { 0: filled.length }) : '' })}
          </button>
          <button onClick={onCancel} disabled={working}>
            {tr('취소')}
          </button>
        </div>
      </div>
    </div>
  );
}
