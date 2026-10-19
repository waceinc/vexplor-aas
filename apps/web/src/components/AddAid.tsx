/**
 * Create collection connection — builds an AID submodel (IDTA-02017) from an endpoint address and tags.
 *
 * Important: **cut down to two steps** (user remark, 2026-09-01: "too hard, and I can't tell whether I must fill everything").
 *    Before, 7 fields (name · NodeId · PLC address · type · unit · category · subcategory) were shown at once, so
 *    nobody could tell what was required, and text got cut off in narrow fields.
 *      (1) equipment address → load    (2) pick tags → create
 *    The optional items (PLC address · unit) were **removed.** They are optional in the AID spec, and browsing does not fill them anyway.
 *    The slot-creation settings were folded into "Details" — the defaults suit most people.
 * Important: shown as a popup. Squeezed into the right panel it lacks width and the layout breaks (measured).
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog.js';
import { api } from '../api.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

interface Props {
  packageId: string;
  /** idShort of the model's leaf elements — matching names to these enables live export */
  leafNames: readonly string[];
  busy: boolean;
  /**
   * Addresses this tool **serves** values on (M6 · M7). If present, putting such an address here is blocked —
   * catching a hand-pasted address before it hits the server's block (409) is kinder.
   */
  outEndpoint?: string;
  onCancel: () => void;
  onDone: (summary: string) => void;
}

import { AidOptions } from './aid/AidOptions.js';
import { BrowsedTags } from './aid/BrowsedTags.js';
import { PickedTags } from './aid/PickedTags.js';
import { PlcHint } from './aid/PlcHint.js';
import { AidPattern } from './aid/AidPattern.js';
import { AidConnection, periodMs } from './aid/AidConnection.js';
import { createdSummary, editableInterface, formFor, periodTextOf, rowsOf, securityOf, securityToSend, tagAddressOf } from './aid/linkInput.js';
import { hasUserInfo, protocolOfEndpoint } from './aid/protocol.js';
import { EMPTY, type TagRow } from './aid/types.js';
import type { AidSecurityChoice } from '../api.js';

/** Tidies it so it can be used as an element name — otherwise "Create" is blocked */
function asElementName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z])/, 'T$1');
}

export function AddAid({ packageId, leafNames, busy, outEndpoint, onCancel, onDone }: Props): React.JSX.Element {
  const [endpoint, setEndpoint] = useState('opc.tcp://');
  const [rows, setRows] = useState<TagRow[]>([]);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [manual, setManual] = useState(false);
  /** Many by pattern — dozens of same-shaped tags */
  const [patternOpen, setPatternOpen] = useState(false);

  /** Tags browsed from the equipment — so NodeIds are not typed by hand */
  const [found, setFound] = useState<Awaited<ReturnType<typeof api.browseDevice>>>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [browsing, setBrowsing] = useState(false);

  // Slot creation — folded away because the defaults suit most people
  const [makeElements, setMakeElements] = useState(true);
  const [group, setGroup] = useState('ProcessMonitoring');
  const [subgroup, setSubgroup] = useState('CollectedValues');
  /** How to connect (2.8.0) — OPC UA security, a login, and the read period in seconds ('' = server default) */
  const [security, setSecurity] = useState<AidSecurityChoice>({});
  const [periodText, setPeriodText] = useState('');

  /**
   * "Edit link" starts from the link that is there (2.8.0) — "Create" replaces the whole AID, so an empty form meant
   * typing every tag again to change one unit. Once, on open; a person's typing is never overwritten.
   */
  useEffect(() => {
    let cancelled = false;
    void api.interfaces(packageId).then(
      ({ interfaces }) => {
        const existing = editableInterface(interfaces);
        if (cancelled || !existing) return;
        setEndpoint((current) => (current === 'opc.tcp://' ? (existing.base ?? current) : current));
        setRows((current) => (current.length === 0 ? rowsOf(existing) : current));
        setSecurity(securityOf(existing));
        setPeriodText(periodTextOf(existing));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [packageId]);

  /** Important: was an address we serve pasted in as is — this incident actually happened */
  const isOurOwn =
    outEndpoint !== undefined && endpoint.trim() !== '' && endpoint.trim() === outEndpoint.trim();

  /** Protocol decided by the endpoint address — loading from equipment works only for OPC UA (for Modbus · MQTT the address is typed) */
  const protocol = protocolOfEndpoint(endpoint);
  const filled = rows.filter((row) => row.name.trim() !== '' && row.href.trim() !== '');
  const period = periodMs(periodText);
  /** A password in the address or an impossible read period — the server would refuse it, so say it here */
  const blocked = hasUserInfo(endpoint) || period === 'bad';
  const misses = filled.filter((row) => !leafNames.includes(row.name.trim())).length;

  const browse = async (): Promise<void> => {
    setBrowsing(true);
    setError(undefined);
    try {
      const chosen = securityToSend(protocol, security).security;
      setFound(await api.browseDevice(endpoint.trim(), chosen));
      setPicked(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBrowsing(false);
    }
  };

  /** Turns the picked items into tags — name is browseName, address is the NodeId as is */
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
          // S7 · MC · XGT: address and data type become one href (`DB10.DBD4:REAL`)
          ...tagAddressOf(protocol, row),
          ...(row.unit?.trim() ? { unit: row.unit.trim() } : {}),
          // Protocol-specific form items (AID binding) — Modbus: register kind · data type · order, MQTT: subscription
          ...formFor(protocol, row),
        })),
        ...securityToSend(protocol, security),
        ...(typeof period === 'number' ? { intervalMs: period } : {}),
        ...(makeElements ? { createMissing: { group: group.trim(), subgroup: subgroup.trim() } } : {}),
      });
      onDone(createdSummary(result));
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
        {/* Important: direction diagram. There are two kinds of "address", so it must be nailed down which one is being configured */}
        <p className="flow">
          <T k={'<b>{0}</b> ──▶ [이 도구] ──▶ [MES·SCADA]{1}'} v={[tr('[설비·PLC]'), <span className="here">{tr('↑ 지금 여기를 설정합니다')}</span>]} />
        </p>
        <p className="hint"><T k={'설비에 붙어 태그를 고르면 <b>AID 서브모델</b>(IDTA-02017)을 규격대로 만듭니다.'} /></p>

        {/* ── (1) Equipment address ───────────────────────────── */}
        <section className="step">
          <h4>
            <T k={'{0} 설비(PLC)의 접속 주소 — OPC UA · Modbus TCP · MQTT · S7 · MC · XGT{1}'} v={[<span className="num">1</span>, <span className="count dim">{tr('내가 접속하러 갈 곳')}</span>]} />
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
          <AidConnection
            {...(protocol ? { protocol } : {})}
            endpoint={endpoint}
            setEndpoint={setEndpoint}
            security={security}
            setSecurity={setSecurity}
            periodText={periodText}
            setPeriodText={setPeriodText}
          />
          {(protocol === 'MODBUS' || protocol === 'MQTT') && (
            <p className="hint">
              {protocol === 'MODBUS'
                ? tr('Modbus TCP 는 설비에서 불러오기가 없습니다 — 아래 「＋ 손으로 입력」으로 주소(예: 40 · 1/40)와 레지스터 종류 · 자료형을 적습니다. 40001 같은 관례 주소는 바꿔 드립니다.')
                : tr('MQTT 는 설비에서 불러오기가 없습니다 — 아래 「＋ 손으로 입력」으로 토픽을 적습니다. 장치가 보낸 마지막 값을 읽습니다.')}
            </p>
          )}
          {(protocol === 'S7' || protocol === 'MC' || protocol === 'XGT') && <PlcHint protocol={protocol} />}
          {isOurOwn && (
            <p className="note warn self-warn">
              <T k={'<b>여기는 설비가 아니라 이 도구 자신입니다.</b> 이 주소는 우리가 상위 앱(MES·SCADA)에 값을 <b>내주는</b> 주소입니다 — 여기서 보이는 것은 설비 태그가 아니라 열려 있는 AAS 파일의 내용(제조사명·일련번호 같은 명판 정보)입니다.<br/>수집할 곳은 <b>설비(PLC)의 주소</b>입니다. 예: {0}<br/>장비 없이 시험만 해 보려면 가상 PLC를 띄우십시오 — {1}'} v={[<span className="mono">opc.tcp://192.168.0.50:4840</span>, <span className="mono">node scripts/plc-simulator.mjs</span>]} />
            </p>
          )}
        </section>

        {/* ── (2) Pick tags ──────────────────────────────────── */}
        <section className="step">
          <h4>
            <T k={'{0} 수집할 태그{1}'} v={[<span className="num">2</span>, filled.length > 0 && <span className="count"><T k={'{0}개 담김'} v={[filled.length]} /></span>]} />
          </h4>

          {found && <BrowsedTags found={found} picked={picked} setPicked={setPicked} setFound={setFound} applyPicked={applyPicked} />}

          {!found && rows.length === 0 && !manual && (protocol === 'OPCUA' || protocol === undefined) && (
            <p className="hint"><T k={'위에 주소를 넣고 <b>「설비에서 불러오기」</b>를 누르면 태그를 골라 담을 수 있습니다.'} /></p>
          )}

          {rows.length > 0 && <PickedTags rows={rows} setRows={setRows} leafNames={leafNames} endpoint={endpoint} {...(protocol ? { protocol } : {})} />}

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
              <span className="hint warn"><T k={'주의 — {0}개는 모델에 없는 이름 — {1}'} v={[misses, makeElements ? tr('자리를 함께 만듭니다') : tr('값이 밖으로 안 나갑니다')]} />
              </span>
            )}
          </div>
        </section>

        {patternOpen && (
          <AidPattern
            hrefExample={protocol === 'MODBUS' ? '{n}' : protocol === 'MQTT' ? 'plant/zone{n}/temp' : protocol === 'S7' ? 'DB1.DBW{n}' : protocol === 'MC' || protocol === 'XGT' ? 'D{n}' : 'ns=1;s=Zone{n}.Temp'}
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

        {/* ── Details — folded away because the defaults suit most people ── */}
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
            disabled={busy || working || isOurOwn || blocked || filled.length === 0}
            title={tr('적은 주소와 태그로 AID 서브모델(IDTA-02017)을 규격대로 만듭니다 — 이미 있으면 새로 만든 것으로 바꿉니다')}
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
