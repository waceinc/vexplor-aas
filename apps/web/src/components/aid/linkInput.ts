/**
 * Create collection link — between the screen and the AID (2.8.0): what "Edit link" starts from (the existing link),
 * and what "Create" sends (tags with units and Modbus order, security, read period).
 *
 * Important: "Create" replaces the whole AID. So "Edit link" must start from what is there — before 2.8.0 it opened
 *    empty, and changing one unit meant typing every tag again. Form fields the screen does not show but the server
 *    accepts are carried through unchanged (`keep`); the rest of a hand-made AID is not.
 */
import type { AidInterfaceView, AidSecurityChoice } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { plcHrefOf, plcWotType, splitPlcHref } from './plc.js';
import { orderFields, orderOf, protocolOfEndpoint, statedPollingMs, type AidProtocolChoice } from './protocol.js';
import type { TagRow } from './types.js';

/** Form fields the server accepts that the screen has no control for — kept as they are */
const KEPT = ['modv_unitID', 'mqv_qos', 'mqv_retain'];
const FUNCTION_ENTITY: Record<string, string> = {
  readcoil: 'Coil',
  readdevicediscreteinput: 'DiscreteInput',
  readholdingregisters: 'HoldingRegister',
  readinputregisters: 'InputRegister',
};

/** The link "Edit link" starts from — the first interface the screen can make, or undefined */
export function editableInterface(interfaces: readonly AidInterfaceView[]): AidInterfaceView | undefined {
  return interfaces.find((iface) => iface.base !== undefined && protocolOfEndpoint(iface.base) !== undefined && iface.properties.some((p) => p.href));
}

export function rowsOf(iface: AidInterfaceView): TagRow[] {
  const protocol = protocolOfEndpoint(iface.base ?? '');
  const modbus = protocol === 'MODBUS';
  return iface.properties.flatMap((property) => {
    if (!property.href) return [];
    const fields = property.formFields ?? {};
    const keep = Object.fromEntries(Object.entries(fields).filter(([key]) => KEPT.includes(key)));
    const row: TagRow = { name: property.name, href: property.href, type: property.type ?? 'float' };
    if (property.unit) row.unit = property.unit;
    if (Object.keys(keep).length > 0) row.keep = keep;
    if (modbus) {
      row.entity = fields['modv_entity'] ?? FUNCTION_ENTITY[(fields['modv_function'] ?? '').toLowerCase()] ?? 'HoldingRegister';
      row.dataType = fields['modv_type'] ?? 'xsd:unsignedShort';
      row.order = orderOf(fields);
    }
    if (protocol === 'S7' || protocol === 'MC') {
      const { address, plcType } = splitPlcHref(protocol, property.href);
      row.href = address;
      row.plcType = plcType;
    }
    return [row];
  });
}

export function securityOf(iface: AidInterfaceView): AidSecurityChoice {
  const stated = iface.security;
  return {
    ...(stated?.mode ? { mode: stated.mode } : {}),
    ...(stated?.policy ? { policy: stated.policy } : {}),
    ...(stated?.userIdentityToken === 'UserName' ? { login: true } : {}),
  };
}

/** The read period an existing link states, in seconds as the screen shows it — '' when none */
export function periodTextOf(iface: AidInterfaceView): string {
  const ms = statedPollingMs(iface.properties);
  return ms === undefined ? '' : String(ms / 1000);
}

/** Protocol-specific form items (AID binding) — Modbus: register kind · data type · order, MQTT: subscription */
export function formFor(protocol: AidProtocolChoice | undefined, row: TagRow): { form?: Record<string, string> } {
  const keep = row.keep ?? {};
  if (protocol === 'MODBUS') {
    const entity = row.entity ?? 'HoldingRegister';
    return {
      form: {
        ...keep,
        modv_entity: entity,
        modv_type: row.dataType ?? 'xsd:unsignedShort',
        // Order means nothing for single bits
        ...(entity.endsWith('Register') ? orderFields(row.order) : {}),
      },
    };
  }
  if (protocol === 'MQTT') return { form: { ...keep, mqv_controlPacket: 'subscribe' } };
  return {};
}

/** The href and AID type to send — S7 · MC join address and data type, the rest send the row as typed */
export function tagAddressOf(protocol: AidProtocolChoice | undefined, row: TagRow): { href: string; type: string } {
  if (protocol === 'S7' || protocol === 'MC') {
    const href = plcHrefOf(row.href, row.plcType);
    return { href, type: plcWotType(protocol, href) };
  }
  return { href: row.href.trim(), type: row.type };
}

/** The security to send — nothing when nothing is chosen, so a plain link stays the same AID as before 2.8.0 */
export function securityToSend(protocol: AidProtocolChoice | undefined, security: AidSecurityChoice): { security?: AidSecurityChoice } {
  const mode = protocol === 'OPCUA' ? (security.mode ?? 'None') : 'None';
  const login = (protocol === 'OPCUA' || protocol === 'MQTT') && security.login === true;
  if (mode === 'None' && !login) return {};
  return { security: { ...(mode !== 'None' ? { mode, policy: security.policy ?? 'Basic256Sha256' } : {}), ...(login ? { login: true } : {}) } };
}

/** The one-line notice after "Create" (moved from AddAid.tsx in 2.8.0, unchanged) */
export function createdSummary(result: { replaced: boolean; nameMisses: string[]; elementsAdded: string[]; elementsConflicted?: string[] }): string {
  // Important: the notice bar is one line — joining three sentences went over 200 characters and nobody read it (measured in a demo).
  //    Good news stays short; only bad news (what could not be created · mismatched names) is appended. The table on the right shows the details
  const made = result.elementsAdded?.length > 0 ? fill(tr(' · 요소 {0}개 새로 만듦'), { 0: result.elementsAdded.length }) : '';
  /* elementsConflicted = no new slot was made because another submodel **already has** the same name.
     Matching tag names to model elements (e.g. Nameplate/SerialNumber) is the normal path, so this is not a warning —
     it used to show as a warning sign and led to "why wasn't it created?" (measured in a demo). The value lands on that existing element */
  const conflicted = result.elementsConflicted ?? [];
  const clash = conflicted.length > 0 ? fill(tr(' · 모델에 이미 있어 그대로 연결: {0}'), { 0: conflicted.join(', ') }) : '';
  const misses =
    result.nameMisses.length > 0 ? fill(tr(' · 주의 — 모델과 이름이 안 맞는 태그 {0}개(표의 「모델연결」 열 참조)'), { 0: result.nameMisses.length }) : '';
  return fill(tr('수집 연결을 {0}{1}{2}{3}'), { 0: result.replaced ? tr('바꿨습니다') : tr('만들었습니다'), 1: made, 2: clash, 3: misses });
}
