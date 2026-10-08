/**
 * 수집 주소 목록 뽑기 — AASX 안의 AID를 「현장에 넘길 표」 한 장으로 바꾼다.
 *
 * 왜 필요한가: 시운전 때 실제로 오가는 종이는 **주소 목록**이다. OT팀에 "이 노드들
 * 읽기 권한을 열어 달라"고 넘기고, 오타·타입 불일치를 접속 전에 눈으로 잡고, 검수에 낸다.
 * 지금까지는 그 목록이 AID 서브모델 안에 중첩 구조로만 있어서 사람이 못 읽었다.
 *
 * 🔴 주소만 뽑지 않는다. **마지막에 무엇이 들어왔는지**(값·품질·시각)와
 *    **모델 요소와 이름이 맞는지**를 같은 줄에 붙인다. 주소만 있는 표는 "적어 둔 주소"일 뿐
 *    "되는 주소"인지는 말해 주지 않는다 — 점검표가 되려면 근거가 한 줄에 있어야 한다.
 *
 * 화면이 없어도 성립하는 순수 로직이다(model.ts와 같은 자리).
 */
import type { AidInterfaceView, CollectedValueView, LiveMapping } from './api.js';
import { localTime } from './model.js';
import { tr, fill } from './i18n.js';
import { csvCell } from '@aas/linter';

export interface AddressRow {
  interfaceName: string;
  protocol: string;
  /** 접속 주소. OPC UA면 opc.tcp://… */
  endpoint: string;
  propertyName: string;
  /** 읽을 주소. OPC UA면 NodeId */
  address: string;
  dataType: string;
  unit: string;
  observable: string;
  latestValue: string;
  quality: string;
  observedAt: string;
  /** 표준 API(?live=true)로 내보내지는지 — 이름이 모델 요소와 맞아야 한다 */
  modelLink: string;
}

export const ADDRESS_COLUMNS = [
  tr('인터페이스'),
  tr('프로토콜'),
  tr('접속주소'),
  tr('항목'),
  tr('주소(NodeId)'),
  tr('데이터타입'),
  tr('단위'),
  tr('관측가능'),
  tr('최근값'),
  tr('품질'),
  tr('수집시각'),
  tr('모델연결'),
] as const;

function displayValue(value: CollectedValueView): string {
  if (value.valueText !== undefined && value.valueText !== '') return value.valueText;
  if (value.valueNumber !== undefined) return String(value.valueNumber);
  return '';
}



/**
 * 모델 연결 상태를 사람 말로. 🔴 `unmatched`를 빈칸으로 두지 않는다 —
 * "값은 쌓이는데 밖에서는 안 보이는" 상태가 표에서 눈에 띄어야 한다.
 */
function modelLinkOf(propertyName: string, live: LiveMapping | undefined): string {
  // 아직 한 번도 수집하지 않았으면 판정 자체가 없다 — 빈칸 대신 그 사실을 적는다
  if (!live) return tr('수집 전');
  const note = live.notes.find((item) => item.propertyName === propertyName);
  if (!note) return '';
  if (note.outcome === 'applied') return tr('연결됨');
  if (note.outcome === 'ambiguous') return fill(tr('이름 중복 ({0}곳)'), { 0: note.paths.length });
  return tr('이름 안 맞음');
}

export function addressRows(
  interfaces: readonly AidInterfaceView[],
  values: readonly CollectedValueView[] = [],
  live?: LiveMapping,
  /**
   * 🔴 붙어서 물어봤지만 **아직 값이 없는** 태그 이름.
   *    빈칸으로 두면 「아직 안 물어봤다」와 구별되지 않는다 — 시운전 점검표에서 그 둘은 전혀 다르다.
   */
  pending: ReadonlySet<string> = new Set(),
): AddressRow[] {
  /** property마다 가장 최근 값 하나 — 수집 화면과 같은 규칙으로 고른다 */
  const latest = new Map<string, CollectedValueView>();
  for (const value of values) {
    const key = `${value.interfaceName}/${value.propertyName}`;
    const current = latest.get(key);
    if (!current || value.observedAt > current.observedAt) latest.set(key, value);
  }

  const rows: AddressRow[] = [];
  for (const descriptor of interfaces) {
    for (const property of descriptor.properties) {
      const value = latest.get(`${descriptor.name}/${property.name}`);
      rows.push({
        interfaceName: descriptor.title ?? descriptor.name,
        protocol: descriptor.protocol,
        endpoint: descriptor.base ?? '',
        propertyName: property.name,
        address: property.href ?? '',
        dataType: property.type ?? '',
        unit: property.unit ?? '',
        observable: property.observable ? tr('예') : tr('아니오'),
        latestValue: value ? displayValue(value) : '',
        quality: value?.quality ?? (pending.has(property.name) ? tr('값 대기') : ''),
        observedAt: value ? localTime(value.observedAt) : '',
        modelLink: modelLinkOf(property.name, live),
      });
    }
  }
  return rows;
}

/** 엑셀에서 열 수 있게. 🔴 BOM을 붙인다 — 없으면 엑셀이 한글을 깨뜨린다 */
export function addressCsv(rows: readonly AddressRow[]): string {
  const escape = (value: string): string => csvCell(value, 'always');
  const lines = [ADDRESS_COLUMNS.map(escape).join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.interfaceName,
        row.protocol,
        row.endpoint,
        row.propertyName,
        row.address,
        row.dataType,
        row.unit,
        row.observable,
        row.latestValue,
        row.quality,
        row.observedAt,
        row.modelLink,
      ]
        .map(escape)
        .join(','),
    );
  }
  return `﻿${lines.join('\r\n')}`;
}
