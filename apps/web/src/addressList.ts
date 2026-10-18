/**
 * Extract the collection address list — turn the AID inside an AASX into one "sheet to hand to the site".
 *
 * Why: the paper that actually changes hands at commissioning is the **address list**. It goes to the OT team as "please open
 * read access to these nodes", lets typos and type mismatches be caught by eye before connecting, and is submitted for acceptance.
 * Until now that list existed only as a nested structure inside the AID submodel, which people could not read.
 *
 * Important: do not extract addresses alone. Put **what came in last** (value, quality, timestamp) and
 *    **whether the name matches a model element** on the same row. A table of addresses only is "addresses written down";
 *    it does not say whether they are "addresses that work" — to be a checklist, the evidence must be on one row.
 *
 * Pure logic that holds without a screen (same place as model.ts).
 */
import type { AidInterfaceView, CollectedValueView, LiveMapping } from './api.js';
import { localTime } from './model.js';
import { tr, fill } from './i18n.js';
import { csvCell } from '@aas/linter';
import { maskedEndpoint } from './components/aid/protocol.js';

export interface AddressRow {
  interfaceName: string;
  protocol: string;
  /** Endpoint address. For OPC UA: opc.tcp://… */
  endpoint: string;
  propertyName: string;
  /** Address to read. For OPC UA: NodeId */
  address: string;
  dataType: string;
  unit: string;
  observable: string;
  latestValue: string;
  quality: string;
  observedAt: string;
  /** Whether it is exposed through the standard API (?live=true) — the name must match a model element */
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
 * Model link status in plain words. Important: do not leave `unmatched` blank —
 * the "values accumulate but are not visible outside" state must stand out in the table.
 */
function modelLinkOf(propertyName: string, live: LiveMapping | undefined): string {
  // Never collected yet means there is no verdict at all — state that fact instead of a blank
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
   * Important: tag names that were requested after connecting but **have no value yet**.
   *    Left blank, they cannot be told apart from "not requested yet" — on a commissioning checklist the two are entirely different.
   */
  pending: ReadonlySet<string> = new Set(),
): AddressRow[] {
  /** The single most recent value per property — chosen by the same rule as the collection screen */
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
        // The password never goes into the CSV (2.8.0)
        endpoint: descriptor.base ? maskedEndpoint(descriptor.base) : '',
        propertyName: property.name,
        address: property.href ?? '',
        dataType: property.type ?? '',
        unit: property.unit ?? '',
        observable: property.observable ? tr('예') : tr('아니오'),
        latestValue: value && value.error === undefined ? displayValue(value) : '',
        quality: value?.error !== undefined ? fill(tr('읽기 실패 — {0}'), { 0: value.error }) : (value?.quality ?? (pending.has(property.name) ? tr('값 대기') : '')),
        observedAt: value ? localTime(value.observedAt) : '',
        modelLink: modelLinkOf(property.name, live),
      });
    }
  }
  return rows;
}

/** So it opens in Excel. Important: add a BOM — without it Excel garbles Korean text */
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
