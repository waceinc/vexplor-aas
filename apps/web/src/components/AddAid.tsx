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
import { Dialog } from '../ui/Dialog.js';
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

import { AidOptions } from './aid/AidOptions.js';
import { BrowsedTags } from './aid/BrowsedTags.js';
import { PickedTags } from './aid/PickedTags.js';
import { AidPattern } from './aid/AidPattern.js';
import { protocolOfEndpoint } from './aid/protocol.js';
import { EMPTY, type TagRow } from './aid/types.js';

/** 프로토콜 고유 폼 항목(AID 바인딩) — Modbus 는 레지스터 종류 · 자료형, MQTT 는 구독. OPC UA 는 없다 */
function formFor(protocol: string | undefined, row: TagRow): { form?: Record<string, string> } {
  if (protocol === 'MODBUS') return { form: { modv_entity: row.entity ?? 'HoldingRegister', modv_type: row.dataType ?? 'xsd:unsignedShort' } };
  if (protocol === 'MQTT') return { form: { mqv_controlPacket: 'subscribe' } };
  return {};
}

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
  /** 패턴으로 여러 개 — 같은 꼴의 태그 수십 개 */
  const [patternOpen, setPatternOpen] = useState(false);

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

  /** 접속 주소로 정한 프로토콜 — 설비에서 불러오기는 OPC UA 만 된다(Modbus · MQTT 는 주소를 적는다) */
  const protocol = protocolOfEndpoint(endpoint);
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
        tags: filled.map((row) => ({
          name: row.name.trim(),
          href: row.href.trim(),
          type: row.type,
          // 프로토콜 고유 폼 항목(AID 바인딩) — Modbus 는 레지스터 종류 · 자료형, MQTT 는 구독
          ...formFor(protocol, row),
        })),
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
    <Dialog
      className="add-aid"
      label={tr('수집 연결 만들기')}
      onClose={onCancel}
      close={{ text: tr('닫기 ✕'), label: tr('수집 연결 닫기') }}
    >
        <h3>{tr('← 수집 연결 만들기 — 설비에서 받아 오기')}</h3>
        {/* 🔴 방향 그림. 「주소」가 두 종류라 무엇을 설정하는 중인지 못박아야 한다 */}
        <p className="flow">
          <T k={'<b>{0}</b> ──▶ [이 도구] ──▶ [MES·SCADA]{1}'} v={[tr('[설비·PLC]'), <span className="here">{tr('↑ 지금 여기를 설정합니다')}</span>]} />
        </p>
        <p className="hint"><T k={'설비에 붙어 태그를 고르면 <b>AID 서브모델</b>(IDTA-02017)을 규격대로 만듭니다.'} /></p>

        {/* ── ① 설비 주소 ───────────────────────────────────── */}
        <section className="step">
          <h4>
            <T k={'{0} 설비(PLC)의 접속 주소 — OPC UA · Modbus TCP · MQTT{1}'} v={[<span className="num">1</span>, <span className="count dim">{tr('내가 접속하러 갈 곳')}</span>]} />
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
              disabled={browsing || isOurOwn || protocol !== 'OPCUA'}
            >
              {browsing ? tr('훑는 중…') : tr('설비에서 불러오기')}
            </button>
          </div>
          {(protocol === 'MODBUS' || protocol === 'MQTT') && (
            <p className="hint">
              {protocol === 'MODBUS'
                ? tr('Modbus TCP 는 설비에서 불러오기가 없습니다 — 아래 「＋ 손으로 입력」으로 주소(예: 40 · 1/40)와 레지스터 종류 · 자료형을 적습니다. 40001 같은 관례 주소는 바꿔 드립니다.')
                : tr('MQTT 는 설비에서 불러오기가 없습니다 — 아래 「＋ 손으로 입력」으로 토픽을 적습니다. 장치가 보낸 마지막 값을 읽습니다.')}
            </p>
          )}
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

          {found && <BrowsedTags found={found} picked={picked} setPicked={setPicked} setFound={setFound} applyPicked={applyPicked} />}

          {!found && rows.length === 0 && !manual && protocol !== 'MODBUS' && protocol !== 'MQTT' && (
            <p className="hint"><T k={'위에 주소를 넣고 <b>「설비에서 불러오기」</b>를 누르면 태그를 골라 담을 수 있습니다.'} /></p>
          )}

          {rows.length > 0 && <PickedTags rows={rows} setRows={setRows} leafNames={leafNames} {...(protocol ? { protocol } : {})} />}

          <div className="row-buttons">
            <button
              className="link"
              title={tr('설비에 붙지 않고 태그 주소를 직접 적습니다 — 주소를 이미 아는 경우')}
              onClick={() => {
                setManual(true);
                setRows([...rows, protocol === 'MODBUS' ? { ...EMPTY, type: 'integer', entity: 'HoldingRegister', dataType: 'xsd:unsignedShort' } : { ...EMPTY }]);
              }}
            >
              {tr('+ 손으로 입력')}
            </button>
            <button
              className="link"
              title={tr('이름 · 주소 틀과 번호 범위로 같은 꼴의 태그를 여러 개 만듭니다')}
              onClick={() => setPatternOpen(true)}
            >
              {tr('+ 패턴으로 여러 개')}
            </button>
            {misses > 0 && (
              <span className="hint warn"><T k={'⚠ {0}개는 모델에 없는 이름 — {1}'} v={[misses, makeElements ? tr('자리를 함께 만듭니다') : tr('값이 밖으로 안 나갑니다')]} />
              </span>
            )}
          </div>
        </section>

        {patternOpen && (
          <AidPattern
            hrefExample={protocol === 'MODBUS' ? '{n}' : protocol === 'MQTT' ? 'plant/zone{n}/temp' : 'ns=1;s=Zone{n}.Temp'}
            onClose={() => setPatternOpen(false)}
            onAdd={(made) => {
              const extra = protocol === 'MODBUS' ? { type: 'integer', entity: 'HoldingRegister', dataType: 'xsd:unsignedShort' } : {};
              const kept = rows.filter((row) => row.name.trim() !== '' || row.href.trim() !== '');
              setRows([...kept, ...made.map((row) => ({ ...EMPTY, ...extra, name: row.name, href: row.href }))]);
              setManual(true);
              setPatternOpen(false);
            }}
          />
        )}

        {/* ── 자세히 — 기본값이 맞는 사람이 대부분이라 접어 둔다 ── */}
        <AidOptions makeElements={makeElements} setMakeElements={setMakeElements} group={group} setGroup={setGroup} subgroup={subgroup} setSubgroup={setSubgroup} />

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
    </Dialog>
  );
}
