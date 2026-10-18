/**
 * The last 24 hours of a collector, one bar per 5 minutes — plain elements, no chart library.
 *
 * Important: the time line is laid out from now back, a slot every 5 minutes. A period with no batch stays empty, so an
 *    outage shows as a gap where it happened instead of the bars closing up around it.
 * Important: each row says its last value and its range in words too — the bars are for the eye, the text is what a
 *    screen reader and a screenshot in a report keep.
 */
import { fill, tr } from '../../i18n.js';
import type { EdgeHistoryPoint } from '../../api/edge.js';
import { millis, percent } from './format.js';

const STEP_MS = 5 * 60_000;
const SLOTS = 288;

interface Series {
  label: string;
  value: (point: EdgeHistoryPoint) => number | undefined;
  format: (value: number) => string;
  /** The top of the bars; undefined = the largest value seen */
  max?: number;
  /** Shown instead of the bars when no point has the value (an edge older than 1.1.0) */
  needsNewEdge?: boolean;
}

function slots(points: EdgeHistoryPoint[], now: number): (EdgeHistoryPoint | undefined)[] {
  const last = Math.floor(now / STEP_MS);
  const byPeriod = new Map(points.map((point) => [Math.floor(Date.parse(point.at) / STEP_MS), point]));
  return Array.from({ length: SLOTS }, (_, i) => byPeriod.get(last - SLOTS + 1 + i));
}

function Row({ series, line }: { series: Series; line: (EdgeHistoryPoint | undefined)[] }): React.JSX.Element {
  const values = line.map((point) => (point ? series.value(point) : undefined));
  const known = values.filter((value): value is number => value !== undefined);
  const top = series.max ?? Math.max(1, ...known);
  if (known.length === 0) {
    return (
      <div className="edge-trend-row">
        <span className="edge-trend-label">{series.label}</span>
        <span className="dim small">{series.needsNewEdge ? tr('이 판은 보내지 않음(1.1.0 이상)') : tr('값 없음')}</span>
      </div>
    );
  }
  const summary = fill(tr('지금 {0} · 가장 낮음 {1} · 가장 높음 {2}'), {
    0: series.format(known.at(-1)!),
    1: series.format(Math.min(...known)),
    2: series.format(Math.max(...known)),
  });
  return (
    <div className="edge-trend-row">
      <span className="edge-trend-label">{series.label}</span>
      <span className="edge-trend-bars" role="img" aria-label={`${series.label}: ${summary}`}>
        {values.map((value, i) => (
          <span
            key={i}
            className={value === undefined ? 'edge-trend-bar empty' : 'edge-trend-bar'}
            style={value === undefined ? undefined : { height: `${Math.max(4, Math.min(100, (value / top) * 100))}%` }}
          />
        ))}
      </span>
      <span className="edge-trend-summary dim small">{summary}</span>
    </div>
  );
}

export function Trend({ points, now = Date.now() }: { points: EdgeHistoryPoint[]; now?: number }): React.JSX.Element {
  if (points.length === 0) return <p className="dim small">{tr('아직 쌓인 기록이 없습니다 — 묶음이 오면 5분마다 한 점씩 남습니다.')}</p>;
  const line = slots(points, now);
  const series: Series[] = [
    { label: tr('받은 값'), value: (point) => point.values, format: (value) => fill(tr('{0}개'), { 0: String(value) }) },
    { label: tr('디스크 남은 공간'), value: (point) => point.disk, format: (value) => percent(value), max: 100, needsNewEdge: true },
    { label: tr('CPU'), value: (point) => point.cpu, format: (value) => percent(value), max: 100, needsNewEdge: true },
    { label: tr('서버 왕복 시간'), value: (point) => point.rtt, format: (value) => millis(value), needsNewEdge: true },
    {
      label: tr('설비 읽기 성공률(가장 낮은 설비)'),
      value: (point) => {
        const ratios = (point.links ?? []).map((link) => link.ratio).filter((value): value is number => value !== undefined);
        return ratios.length > 0 ? Math.min(...ratios) * 100 : undefined;
      },
      format: (value) => percent(value),
      max: 100,
      needsNewEdge: true,
    },
  ];
  return (
    <div className="edge-trend">
      {series.map((item) => (
        <Row key={item.label} series={item} line={line} />
      ))}
      <p className="dim small">{tr('빈 칸은 그 5분 동안 받은 묶음이 없었다는 뜻입니다.')}</p>
    </div>
  );
}
