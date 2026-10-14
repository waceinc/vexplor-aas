/**
 * **Operational evidence** for reference bundles — a record that stands in for a live demo at submissions where a demo is not possible.
 *
 * A bundle is a type model, so it has no values. Values accumulate on the **instance (unit)** where that type is attached to a real line.
 * The link between them is the AAS standard field `derivedFrom` (unit → source type) — set by "split per unit".
 * So when exporting a bundle, for each equipment we gather the collected values of **itself + the units derived from it**.
 *
 * Important: value sync option A is unchanged. Collected values are not written back to the model — they go out only as separate bundle files (CSV, record).
 * Important: bundles are published on GitHub. **Field PLC addresses are masked** (only local PC addresses stay as-is — for simulation reproduction).
 * Important: the evidence level (A field / B reproduction / C simulation) is chosen by a person. All the tool knows is whether the collection connection is
 *    the built-in virtual PLC (endpoint path /UA/Simulator, or a "simulation" marker in the connection name written in the AAS file), and only then does it suggest C.
 *    Important: do not compare against text translated into the UI language — decide by data (the path, the name written in the file).
 */
import { parseAid } from '@aas/collector';
import { csvCell } from '@aas/linter';
import { currentLang, fill, tr, type Environment } from '@aas/core';
import type { AasStore, CollectedValue, PackageRecord } from '@aas/store';
import { localTimestamp } from './packages.js';

/** Cap on collected values per bundle (per unit). Beyond it, only the latest are included and that fact is noted */
export const EVIDENCE_LIMIT = 200_000;

export type EvidenceLevel = 'A' | 'B' | 'C';
/** Evidence level descriptions — Korean source text (dictionary keys). Goes through `tr()` wherever people read it */
export const EVIDENCE_LEVELS: Record<EvidenceLevel, string> = {
  A: '현장 적용 — Pilot 기업 실제 설비의 수집값(비식별화)', // i18n-ignore — dictionary key (translated via tr() when used)
  B: '실장비 기반 재현 — 실제 태그 구조, 값은 가공',
  C: '시뮬레이션 — 가상 PLC 값', // i18n-ignore — dictionary key (translated via tr() when used)
};

/** Evidence level description in the current language — for UI responses */
export const evidenceLevelNames = (): Record<EvidenceLevel, string> => ({
  A: tr(EVIDENCE_LEVELS.A),
  B: tr(EVIDENCE_LEVELS.B),
  C: tr(EVIDENCE_LEVELS.C),
});

/** Endpoint path of the built-in virtual PLC — same value as @aas/opcua SIMULATOR_RESOURCE_PATH (opcua is loaded lazily, so it cannot be imported here) */
const SIMULATOR_PATH = '/UA/Simulator';
// i18n-ignore — submission bundle folder/file name (spec structure)
const SAMPLES_CSV = '05_샘플데이터/수집값_*.csv';
// i18n-ignore — marker compared against connection names written in AAS files (data). Translating it would fail to recognize files made in Korean
const SIMULATION_MARKS = ['시뮬레이션', 'simulation'];

/** Is this a simulation collection connection — decided by endpoint path or the name written in the file (independent of UI language) */
export function isSimulatedInterface(title: string, base: string | undefined): boolean {
  try {
    if (base && new URL(base.replace(/^[a-z.+-]+:/i, 'http:')).pathname === SIMULATOR_PATH) return true;
  } catch {
    // If the address looks malformed, judge by name only
  }
  const lower = title.toLowerCase();
  return SIMULATION_MARKS.some((mark) => lower.includes(mark));
}

export interface EvidenceSource {
  /** Name of the equipment (type) in the bundle */
  model: string;
  modelFile: string;
  /** The file whose values were gathered — the type itself or a unit derived from it */
  instance: string;
  instanceFile: string;
  /** Whether values were gathered by attaching directly to the type itself (rather than a derived unit) */
  direct: boolean;
  interfaces: { title: string; endpoint: string; simulated: boolean }[];
  values: CollectedValue[];
  truncated: boolean;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/** Address for a public bundle — mask the host unless it is the local PC */
export function maskEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return tr('(주소 없음)');
  const match = /^([a-z.+-]+:\/\/)([^/:]+|\[[^\]]+\])(.*)$/i.exec(endpoint);
  if (!match) return tr('(비공개)');
  const [, scheme, host, rest] = match;
  return LOOPBACK.test(host!) ? endpoint : `${scheme}${tr('(비공개)')}${rest}`;
}

interface ShellLink {
  record: PackageRecord;
  name: string;
  aasId?: string;
  derivedFrom?: string;
}

async function shellLinks(store: AasStore): Promise<ShellLink[]> {
  const out: ShellLink[] = [];
  const all = await store.listPackages({ limit: 1000 });
  for (const record of all.items) {
    const shells = await store.listIdentifiables(record.id, 'AssetAdministrationShell');
    const content = shells.items[0]?.content as
      | { id?: string; idShort?: string; derivedFrom?: { keys?: { value?: string }[] } }
      | undefined;
    out.push({
      record,
      name: content?.idShort ?? record.name,
      ...(content?.id ? { aasId: content.id } : {}),
      ...(content?.derivedFrom?.keys?.[0]?.value ? { derivedFrom: content.derivedFrom.keys[0].value } : {}),
    });
  }
  return out;
}

/**
 * Gather evidence for the bundle's equipment. Only once even if the same equipment appears in two processes.
 * @param models equipment files (types) in the bundle
 */
export async function gatherEvidence(
  store: AasStore,
  models: { name: string; record: PackageRecord }[],
  /** Only entries after this time (ISO) — when you want to drop noise accumulated during testing */
  window: { from?: string } = {},
): Promise<EvidenceSource[]> {
  const links = await shellLinks(store);
  const sources: EvidenceSource[] = [];
  const done = new Set<string>();

  for (const model of models) {
    if (done.has(model.record.id)) continue;
    done.add(model.record.id);
    const self = links.find((link) => link.record.id === model.record.id);
    const derived = self?.aasId ? links.filter((link) => link.derivedFrom === self.aasId) : [];

    for (const candidate of [...(self ? [self] : []), ...derived]) {
      const values = await store.readValues(candidate.record.id, {
        limit: EVIDENCE_LIMIT,
        ...(window.from ? { from: window.from } : {}),
      });
      if (values.length === 0) continue;
      const environment: Environment = (await store.exportPackage(candidate.record.id)).environment;
      const interfaces = parseAid(environment).map((iface) => {
        const title = iface.title ?? iface.name;
        return { title, endpoint: maskEndpoint(iface.base), simulated: isSimulatedInterface(title, iface.base) };
      });
      sources.push({
        model: model.name,
        modelFile: model.record.name,
        instance: candidate.name,
        instanceFile: candidate.record.name,
        direct: candidate === self,
        interfaces,
        // The store returns newest first — the record must read in chronological order
        values: [...values].reverse(),
        truncated: values.length >= EVIDENCE_LIMIT,
      });
    }
  }
  return sources;
}

/** Suggest C if all collection connections are simulations. Otherwise a person chooses */
export function suggestedLevel(sources: EvidenceSource[]): EvidenceLevel | null {
  const interfaces = sources.flatMap((source) => source.interfaces);
  return interfaces.length > 0 && interfaces.every((iface) => iface.simulated) ? 'C' : null;
}

const valueOf = (value: CollectedValue): string =>
  value.valueNumber !== undefined ? String(value.valueNumber) : (value.valueText ?? '');

const cell = (text: string): string => csvCell(text);

/** Collected-values CSV for one unit — raw material for computing KPIs in Excel */
export function evidenceCsv(source: EvidenceSource): string {
  // The header is text people read in Excel — the tool never reads it back (when opening a bundle, this CSV is kept only as an attachment)
  const rows = [[tr('시각'), tr('설비(형식)'), tr('호기'), tr('인터페이스'), tr('항목'), tr('읽은 주소'), tr('값'), tr('품질')].join(',')];
  for (const value of source.values) {
    rows.push(
      [
        value.observedAt,
        source.model,
        source.instance,
        value.interfaceName,
        value.propertyName,
        value.source ?? '',
        valueOf(value),
        value.quality ?? '',
      ]
        .map(cell)
        .join(','),
    );
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

export interface PropertyStat {
  name: string;
  samples: number;
  good: number;
  latest: string;
  numeric?: { min: number; max: number; avg: number; series: number[] };
  /** Distribution of text values — for an operating-status item, this is raw material for the availability rate */
  distribution?: { value: string; share: number }[];
}

const isGood = (quality: string | undefined): boolean => quality === undefined || /^good/i.test(quality);

export function propertyStats(values: CollectedValue[]): PropertyStat[] {
  const byName = new Map<string, CollectedValue[]>();
  for (const value of values) byName.set(value.propertyName, [...(byName.get(value.propertyName) ?? []), value]);
  // Sort by name — so units can be placed side by side and compared
  return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
    const good = list.filter((v) => isGood(v.quality));
    const numbers = good.map((v) => v.valueNumber).filter((n): n is number => typeof n === 'number');
    const stat: PropertyStat = { name, samples: list.length, good: good.length, latest: valueOf(list[list.length - 1]!) };
    if (numbers.length > 0 && numbers.length === good.length) {
      const sum = numbers.reduce((a, b) => a + b, 0);
      stat.numeric = {
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        avg: sum / numbers.length,
        series: numbers.slice(-120),
      };
    } else if (good.length > 0) {
      const counts = new Map<string, number>();
      for (const v of good) counts.set(valueOf(v), (counts.get(valueOf(v)) ?? 0) + 1);
      stat.distribution = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, share: count / good.length }));
    }
    return stat;
  });
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const fmt = (n: number): string => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, '');

/** Small trend line — a single black line so it stays visible when printed on paper */
function sparkline(series: number[]): string {
  if (series.length < 2) return '';
  const min = Math.min(...series);
  const span = Math.max(...series) - min || 1;
  const points = series
    .map((v, i) => `${((i / (series.length - 1)) * 118 + 1).toFixed(1)},${(21 - ((v - min) / span) * 20).toFixed(1)}`)
    .join(' ');
  return `<svg width="120" height="22" viewBox="0 0 120 22" aria-hidden="true"><polyline fill="none" stroke="#1f5fbf" stroke-width="1.2" points="${points}"/></svg>`;
}

const period = (values: CollectedValue[]): { from: string; to: string; minutes: number } => {
  const from = values[0]?.observedAt ?? '';
  const to = values[values.length - 1]?.observedAt ?? '';
  const minutes = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 60000) : 0;
  return { from, to, minutes };
};

/** Time printed in the record — server local time (to the minute), same as the report. CSV is read by machines, so ISO as-is */
const local = (iso: string): string => (iso ? localTimestamp(new Date(iso)) : '');

/** Collection record — goes in the bundle's 06 verification-results folder. Printing it yields a PDF directly */
export function evidenceHtml(options: {
  title: string;
  level: EvidenceLevel | null;
  generatedAt: string;
  tool: string;
  sources: EvidenceSource[];
}): string {
  const { sources, level } = options;
  const total = sources.reduce((sum, s) => sum + s.values.length, 0);
  const levelText = level
    ? fill(tr('증빙 수준 {0} — {1}'), { 0: level, 1: tr(EVIDENCE_LEVELS[level]) })
    : tr('증빙 수준 미지정 — 사람이 채울 것(A 현장 / B 재현 / C 시뮬레이션)');
  const sections = sources.map((source) => {
    const p = period(source.values);
    const stats = propertyStats(source.values);
    const rows = stats
      .map((stat) => {
        const detail = stat.numeric
          ? fill(tr('최소 {0} · 평균 {1} · 최대 {2}'), { 0: fmt(stat.numeric.min), 1: fmt(stat.numeric.avg), 2: fmt(stat.numeric.max) })
          : (stat.distribution ?? [])
              .slice(0, 4)
              .map((d) => `${escapeHtml(d.value)} ${(d.share * 100).toFixed(0)}%`)
              .join(' · ');
        return `<tr><td>${escapeHtml(stat.name)}</td><td class="n">${stat.samples}</td><td class="n">${stat.good === stat.samples ? tr('전부') : `${stat.good}`}</td><td>${escapeHtml(stat.latest)}</td><td>${detail}</td><td>${stat.numeric ? sparkline(stat.numeric.series) : ''}</td></tr>`;
      })
      .join('\n');
    const ifaces = source.interfaces
      .map((i) => `${escapeHtml(i.title)} <code>${escapeHtml(i.endpoint)}</code>`)
      .join('<br>');
    return `<section>
<h2>${escapeHtml(source.model)} ${source.direct ? '' : `← <span class="inst">${escapeHtml(source.instance)}</span>`}</h2>
<table class="meta">
<tr><th>${tr('형식 모델')}</th><td>${escapeHtml(source.modelFile)}</td></tr>
<tr><th>${tr('값을 모은 파일')}</th><td>${escapeHtml(source.instanceFile)} ${source.direct ? tr('(형식 파일에 직접 연결)') : tr('(형식에서 파생된 호기 — derivedFrom)')}</td></tr>
<tr><th>${tr('수집 연결')}</th><td>${ifaces || tr('(연결 정보 없음)')}</td></tr>
<tr><th>${tr('기간')}</th><td>${escapeHtml(local(p.from))} ~ ${escapeHtml(local(p.to))} ${fill(tr('(약 {0}분)'), { 0: p.minutes })}</td></tr>
<tr><th>${tr('수집 건수')}</th><td>${fill(tr('{0}건{1} · 항목 {2}개'), {
  0: source.values.length.toLocaleString('ko-KR'),
  1: source.truncated ? ` ${tr('(상한에 걸려 최근 것만)')}` : '',
  2: stats.length,
})}</td></tr>
</table>
<table class="stats"><thead><tr><th>${tr('항목')}</th><th>${tr('건수')}</th><th>${tr('정상')}</th><th>${tr('마지막 값')}</th><th>${tr('분포')}</th><th>${tr('추이')}</th></tr></thead><tbody>
${rows}
</tbody></table>
</section>`;
  });

  const heading = fill(tr('수집 기록서 — {0}'), { 0: escapeHtml(options.title) });
  return `<!doctype html>
<html lang="${currentLang()}"><head><meta charset="utf-8"><title>${heading}</title>
<style>
  :root { color-scheme: light; }
  body { font: 12px/1.6 -apple-system, 'Malgun Gothic', sans-serif; color: #16191d; margin: 32px; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 6px; border-bottom: 2px solid #16191d; padding-bottom: 2px; }
  .inst { color: #1f5fbf; } .sub { color: #555; margin-bottom: 12px; }
  .level { display: inline-block; padding: 4px 10px; border: 2px solid #b35c00; color: #b35c00; font-weight: 700; border-radius: 4px; margin: 6px 0 12px; }
  .level.set { border-color: #1f5fbf; color: #1f5fbf; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0; } th, td { border: 1px solid #c9ced6; padding: 3px 6px; text-align: left; vertical-align: middle; }
  th { background: #f1f3f6; } .meta th { width: 130px; } .n { text-align: right; font-variant-numeric: tabular-nums; }
  code { font-size: 11px; } .note { color: #555; margin-top: 18px; border-top: 1px solid #c9ced6; padding-top: 8px; }
  @media print { body { margin: 12mm; } section { break-inside: avoid; } }
</style></head><body>
<h1>${heading}</h1>
<div class="sub">${fill(tr('만든 시각 {0} · {1} · 설비 {2}곳 · 수집 {3}건'), {
    0: escapeHtml(options.generatedAt),
    1: escapeHtml(options.tool),
    2: sources.length,
    3: total.toLocaleString('ko-KR'),
  })}</div>
<div class="level ${level ? 'set' : ''}">${escapeHtml(levelText)}</div>
${sections.join('\n')}
<p class="note">
${tr('· 값은 이 도구가 수집 연결(AID, IDTA 02017)로 읽어 저장소에 쌓은 기록 그대로입니다. 모델(AASX)에는 되쓰지 않습니다(값 동기화 A안).')}<br>
${fill(tr('· 전체 값은 <code>{0}</code>에 있습니다. KPI(가동률 등) 계산은 그 CSV로 합니다.'), { 0: SAMPLES_CSV })}<br>
${tr('· 현장 설비 주소는 공개 번들이므로 가렸습니다. 자기 PC 주소(127.0.0.1)는 재현용으로 그대로 둡니다.')}
</p>
</body></html>
`;
}
