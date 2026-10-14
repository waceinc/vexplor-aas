/**
 * Create collection connection — picked tags — name · address · type on one line. Names not in the model are flagged with a border.
 * Split out of components/AddAid.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 */
import { fill, tr } from '../../i18n.js';
import { aidTypeOf, fromModiconAddress, MODBUS_ENTITIES, MODBUS_TYPES, type AidProtocolChoice } from './protocol.js';
import type { TagRow } from './types.js';

interface Props {
  rows: TagRow[];
  setRows: (rows: TagRow[]) => void;
  leafNames: readonly string[];
  /** Protocol set by the endpoint address — Modbus takes kind and data type, MQTT takes a topic */
  protocol?: AidProtocolChoice;
}

function entityLabel(entity: string): string {
  if (entity === 'HoldingRegister') return tr('보유 레지스터');
  if (entity === 'InputRegister') return tr('입력 레지스터');
  if (entity === 'Coil') return tr('코일');
  return tr('입력 비트');
}

export function PickedTags({ rows, setRows, leafNames, protocol = 'OPCUA' }: Props): React.JSX.Element {
  const update = (index: number, patch: Partial<TagRow>): void => setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const modbus = protocol === 'MODBUS';
  return (
    <ul className="picked-list">
      {rows.map((row, index) => (
        <li key={index} className={modbus ? 'modbus' : undefined}>
          <input
            value={row.name}
            list="leaf-names"
            aria-label={fill(tr('태그 {0} 이름'), { 0: index + 1 })}
            className={row.name.trim() !== '' && !leafNames.includes(row.name.trim()) ? 'miss' : ''}
            onChange={(event) => update(index, { name: event.target.value })}
            placeholder={tr('이름')}
          />
          <input
            value={row.href}
            className="mono"
            aria-label={fill(tr('태그 {0} 주소'), { 0: index + 1 })}
            onChange={(event) => update(index, { href: event.target.value })}
            placeholder={modbus ? tr('주소 — 예: 40 · 1/40') : protocol === 'MQTT' ? tr('토픽 — 예: plant/press/temp') : 'NodeId'}
          />
          {modbus && (() => {
            const modicon = fromModiconAddress(row.href);
            return (
              <>
                <select value={row.entity ?? 'HoldingRegister'} aria-label={fill(tr('태그 {0} 레지스터 종류'), { 0: index + 1 })} onChange={(event) => update(index, { entity: event.target.value })}>
                  {MODBUS_ENTITIES.map((entity) => (
                    <option key={entity} value={entity}>{entityLabel(entity)}</option>
                  ))}
                </select>
                <select
                  value={row.dataType ?? 'xsd:unsignedShort'}
                  aria-label={fill(tr('태그 {0} 자료형'), { 0: index + 1 })}
                  onChange={(event) => update(index, { dataType: event.target.value, type: aidTypeOf(event.target.value) })}
                >
                  {MODBUS_TYPES.map((dataType) => (
                    <option key={dataType} value={dataType}>{dataType.replace('xsd:', '')}</option>
                  ))}
                </select>
                {modicon && (
                  <button
                    className="link modicon"
                    title={tr('관례 주소(앞자리가 종류)를 레지스터 종류와 0 기준 주소로 바꿉니다')}
                    onClick={() => update(index, { entity: modicon.entity, href: String(modicon.address) })}
                  >
                    {fill(tr('{0} → {1} {2}번'), { 0: row.href.trim(), 1: entityLabel(modicon.entity), 2: modicon.address })}
                  </button>
                )}
              </>
            );
          })()}
          {!modbus && <select
            value={row.type}
            aria-label={fill(tr('태그 {0} 타입'), { 0: index + 1 })}
            onChange={(event) => update(index, { type: event.target.value })}
          >
            {['float', 'integer', 'string', 'boolean'].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>}
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
  );
}
