/**
 * 레퍼런스 번들의 **실동작 증빙** — 시연을 못 하는 제출 자리에서 시연을 대신하는 기록.
 *
 * 번들은 형식(Type) 모델이라 값이 없다. 값은 그 형식을 실제 라인에 붙인 **호기(Instance)** 에 쌓인다.
 * 둘을 잇는 끈은 AAS 표준 필드 `derivedFrom`(호기 → 원본 형식)이다 — 「호기별로 나누기」가 단다.
 * 그래서 번들을 내보낼 때 설비마다 **자기 자신 + 거기서 파생된 호기**의 수집값을 모아 넣는다.
 *
 * 🔴 값 동기화 A안은 그대로다. 수집값을 모델에 되쓰지 않는다 — 번들의 별도 파일(CSV·기록서)로만 나간다.
 * 🔴 번들은 GitHub에 공개된다. **현장 PLC 주소는 가린다**(자기 PC 주소만 그대로 — 시뮬레이션 재현용).
 * 🔴 증빙 수준(A 현장 / B 재현 / C 시뮬레이션)은 사람이 고른다. 도구가 아는 것은 인터페이스 이름에
 *    「시뮬레이션」이 박혀 있는지뿐이라, 그때만 C를 기본값으로 제안한다.
 */
import { parseAid } from '@aas/collector';
import type { Environment } from '@aas/core';
import type { AasStore, CollectedValue, PackageRecord } from '@aas/store';
import { localTimestamp } from './packages.js';

/** 한 번들에 싣는 수집값 상한(호기당). 넘으면 최근 것만 싣고 그 사실을 적는다 */
export const EVIDENCE_LIMIT = 200_000;

export type EvidenceLevel = 'A' | 'B' | 'C';
export const EVIDENCE_LEVELS: Record<EvidenceLevel, string> = {
  A: '현장 적용 — Pilot 기업 실제 설비의 수집값(비식별화)',
  B: '실장비 기반 재현 — 실제 태그 구조, 값은 가공',
  C: '시뮬레이션 — 가상 PLC 값',
};

export interface EvidenceSource {
  /** 번들 안 설비(형식) 이름 */
  model: string;
  modelFile: string;
  /** 값을 모은 파일 — 형식 자신이거나 거기서 파생된 호기 */
  instance: string;
  instanceFile: string;
  /** 형식 자신에 직접 붙여 모았는가(파생 호기가 아니라) */
  direct: boolean;
  interfaces: { title: string; endpoint: string; simulated: boolean }[];
  values: CollectedValue[];
  truncated: boolean;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/** 공개 번들용 주소 — 자기 PC가 아니면 호스트를 가린다 */
export function maskEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return '(주소 없음)';
  const match = /^([a-z.+-]+:\/\/)([^/:]+|\[[^\]]+\])(.*)$/i.exec(endpoint);
  if (!match) return '(비공개)';
  const [, scheme, host, rest] = match;
  return LOOPBACK.test(host!) ? endpoint : `${scheme}(비공개)${rest}`;
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
 * 번들 설비들의 증빙을 모은다. 같은 설비가 두 공정에 있어도 한 번만.
 * @param models 번들 안 설비 파일(형식)
 */
export async function gatherEvidence(
  store: AasStore,
  models: { name: string; record: PackageRecord }[],
  /** 이 시각(ISO) 이후 것만 — 시험하며 쌓인 잡음을 빼고 싶을 때 */
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
        return { title, endpoint: maskEndpoint(iface.base), simulated: title.includes('시뮬레이션') };
      });
      sources.push({
        model: model.name,
        modelFile: model.record.name,
        instance: candidate.name,
        instanceFile: candidate.record.name,
        direct: candidate === self,
        interfaces,
        // 저장소는 최근 것을 앞에 준다 — 기록은 시간 순으로 읽혀야 한다
        values: [...values].reverse(),
        truncated: values.length >= EVIDENCE_LIMIT,
      });
    }
  }
  return sources;
}

/** 인터페이스 이름에 「시뮬레이션」이 박힌 것뿐이면 C를 제안한다. 그 밖엔 사람이 고른다 */
export function suggestedLevel(sources: EvidenceSource[]): EvidenceLevel | null {
  const interfaces = sources.flatMap((source) => source.interfaces);
  return interfaces.length > 0 && interfaces.every((iface) => iface.simulated) ? 'C' : null;
}

const valueOf = (value: CollectedValue): string =>
  value.valueNumber !== undefined ? String(value.valueNumber) : (value.valueText ?? '');

const cell = (text: string): string => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** 호기 하나의 수집값 CSV — 엑셀로 KPI를 계산하는 재료 */
export function evidenceCsv(source: EvidenceSource): string {
  const rows = [['시각', '설비(형식)', '호기', '인터페이스', '항목', '읽은 주소', '값', '품질'].join(',')];
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
  /** 글자 값 분포 — 가동상태면 곧 가동률의 재료다 */
  distribution?: { value: string; share: number }[];
}

const isGood = (quality: string | undefined): boolean => quality === undefined || /^good/i.test(quality);

export function propertyStats(values: CollectedValue[]): PropertyStat[] {
  const byName = new Map<string, CollectedValue[]>();
  for (const value of values) byName.set(value.propertyName, [...(byName.get(value.propertyName) ?? []), value]);
  // 이름순 — 호기끼리 나란히 놓고 비교할 수 있게
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

/** 작은 추이선 — 종이에 인쇄해도 보이게 검은 선 하나 */
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

/** 기록서에 찍는 시각 — 결과서와 같이 서버 지역 시각(분까지). CSV는 기계가 읽으므로 ISO 원문 */
const local = (iso: string): string => (iso ? localTimestamp(new Date(iso)) : '');

/** 수집 기록서 — 번들 06_검증결과. 인쇄하면 그대로 PDF가 된다 */
export function evidenceHtml(options: {
  title: string;
  level: EvidenceLevel | null;
  generatedAt: string;
  tool: string;
  sources: EvidenceSource[];
}): string {
  const { sources, level } = options;
  const total = sources.reduce((sum, s) => sum + s.values.length, 0);
  const levelText = level ? `증빙 수준 ${level} — ${EVIDENCE_LEVELS[level]}` : '증빙 수준 미지정 — 사람이 채울 것(A 현장 / B 재현 / C 시뮬레이션)';
  const sections = sources.map((source) => {
    const p = period(source.values);
    const stats = propertyStats(source.values);
    const rows = stats
      .map((stat) => {
        const detail = stat.numeric
          ? `최소 ${fmt(stat.numeric.min)} · 평균 ${fmt(stat.numeric.avg)} · 최대 ${fmt(stat.numeric.max)}`
          : (stat.distribution ?? [])
              .slice(0, 4)
              .map((d) => `${escapeHtml(d.value)} ${(d.share * 100).toFixed(0)}%`)
              .join(' · ');
        return `<tr><td>${escapeHtml(stat.name)}</td><td class="n">${stat.samples}</td><td class="n">${stat.good === stat.samples ? '전부' : `${stat.good}`}</td><td>${escapeHtml(stat.latest)}</td><td>${detail}</td><td>${stat.numeric ? sparkline(stat.numeric.series) : ''}</td></tr>`;
      })
      .join('\n');
    const ifaces = source.interfaces
      .map((i) => `${escapeHtml(i.title)} <code>${escapeHtml(i.endpoint)}</code>`)
      .join('<br>');
    return `<section>
<h2>${escapeHtml(source.model)} ${source.direct ? '' : `← <span class="inst">${escapeHtml(source.instance)}</span>`}</h2>
<table class="meta">
<tr><th>형식 모델</th><td>${escapeHtml(source.modelFile)}</td></tr>
<tr><th>값을 모은 파일</th><td>${escapeHtml(source.instanceFile)} ${source.direct ? '(형식 파일에 직접 연결)' : '(형식에서 파생된 호기 — derivedFrom)'}</td></tr>
<tr><th>수집 연결</th><td>${ifaces || '(연결 정보 없음)'}</td></tr>
<tr><th>기간</th><td>${escapeHtml(local(p.from))} ~ ${escapeHtml(local(p.to))} (약 ${p.minutes}분)</td></tr>
<tr><th>수집 건수</th><td>${source.values.length.toLocaleString('ko-KR')}건${source.truncated ? ' (상한에 걸려 최근 것만)' : ''} · 항목 ${stats.length}개</td></tr>
</table>
<table class="stats"><thead><tr><th>항목</th><th>건수</th><th>정상</th><th>마지막 값</th><th>분포</th><th>추이</th></tr></thead><tbody>
${rows}
</tbody></table>
</section>`;
  });

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>수집 기록서 — ${escapeHtml(options.title)}</title>
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
<h1>수집 기록서 — ${escapeHtml(options.title)}</h1>
<div class="sub">만든 시각 ${escapeHtml(options.generatedAt)} · ${escapeHtml(options.tool)} · 설비 ${sources.length}곳 · 수집 ${total.toLocaleString('ko-KR')}건</div>
<div class="level ${level ? 'set' : ''}">${escapeHtml(levelText)}</div>
${sections.join('\n')}
<p class="note">
· 값은 이 도구가 수집 연결(AID, IDTA 02017)로 읽어 저장소에 쌓은 기록 그대로입니다. 모델(AASX)에는 되쓰지 않습니다(값 동기화 A안).<br>
· 전체 값은 <code>05_샘플데이터/수집값_*.csv</code>에 있습니다. KPI(가동률 등) 계산은 그 CSV로 합니다.<br>
· 현장 설비 주소는 공개 번들이므로 가렸습니다. 자기 PC 주소(127.0.0.1)는 재현용으로 그대로 둡니다.
</p>
</body></html>
`;
}
