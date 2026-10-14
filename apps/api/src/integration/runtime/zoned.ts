/**
 * Calendar windows in a configured time zone — production days, shifts and hours (docs/design/integration-v1.md §6.4).
 *
 * The server's own time zone is irrelevant: a plant in Seoul served from a UTC container still starts its day at 08:00
 * KST. No dependency — the offset of a zone at an instant comes from `Intl.DateTimeFormat`.
 *
 * Important: daylight saving. A window start is converted with the offset **at that start**, and the end of a day is
 *    the start of the next day (not start + 24 h), so a day that contains a DST change is 23 or 25 hours long, as the
 *    plant experiences it. Asia/Seoul has no DST; the Europe/Berlin case is tested.
 */
import type { ShiftDefinition } from '@aas/core';

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, found);
  }
  return found;
}

/** Wall-clock parts of an instant in a zone */
export function localParts(zone: string, epochMs: number): LocalParts & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts['year']!, month: parts['month']!, day: parts['day']!, hour: parts['hour']! % 24, minute: parts['minute']!, second: parts['second']! };
}

/** Offset of the zone from UTC at an instant (ms, east positive) */
export function zoneOffsetMs(zone: string, epochMs: number): number {
  const p = localParts(zone, epochMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant a wall-clock time in a zone denotes. In a DST gap (02:30 on a spring-forward day) the result is the
 * instant one hour later; in an overlap the earlier of the two — either way a well-defined instant.
 */
export function zonedInstant(zone: string, local: LocalParts): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let instant = guess - zoneOffsetMs(zone, guess);
  // A second pass settles the offset when the first guess sat on the other side of a DST change
  instant = guess - zoneOffsetMs(zone, instant);
  return instant;
}

/** `YYYY-MM-DD` + n days (calendar arithmetic, no zone involved) */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(text: string): boolean {
  const match = DAY.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text;
}

function partsOfDay(day: string, hour: number, minute = 0): LocalParts {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return { year, month, day: date, hour, minute };
}

/** The production day that starts on `day` at `startHour` in the zone, until the same hour of the next day */
export function dayWindow(zone: string, day: string, startHour: number): { start: number; end: number } {
  return { start: zonedInstant(zone, partsOfDay(day, startHour)), end: zonedInstant(zone, partsOfDay(addDays(day, 1), startHour)) };
}

function hhmm(text: string): [number, number] {
  const [h, m] = text.split(':').map(Number) as [number, number];
  return [h, m];
}

/** A shift of a production day — an end at or before the start means it ends on the next calendar day */
export function shiftWindow(zone: string, day: string, shift: ShiftDefinition): { start: number; end: number } {
  const [sh, sm] = hhmm(shift.start);
  const [eh, em] = hhmm(shift.end);
  const overnight = eh * 60 + em <= sh * 60 + sm;
  return {
    start: zonedInstant(zone, partsOfDay(day, sh, sm)),
    end: zonedInstant(zone, partsOfDay(overnight ? addDays(day, 1) : day, eh, em)),
  };
}

/** The production day (`YYYY-MM-DD`, the day its window starts on) an instant belongs to */
export function productionDayOf(zone: string, epochMs: number, startHour: number): string {
  const p = localParts(zone, epochMs);
  const calendar = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return p.hour < startHour ? addDays(calendar, -1) : calendar;
}

export interface Period {
  start: number;
  end: number;
  /** Shift name for shift periods */
  label?: string;
}

/**
 * Consecutive periods overlapping [from, to), clipped to it.
 * - `hour`: wall-clock hours of the zone
 * - `day`: production days (`dayStartHour`)
 * - `shift`: the configured shifts of every production day; no shifts configured → no periods
 */
export function periodsBetween(
  zone: string,
  from: number,
  to: number,
  period: 'hour' | 'shift' | 'day',
  dayStartHour: number,
  shifts: readonly ShiftDefinition[],
): Period[] {
  const out: Period[] = [];
  const push = (start: number, end: number, label?: string): void => {
    const a = Math.max(start, from);
    const b = Math.min(end, to);
    if (b > a) out.push({ start: a, end: b, ...(label === undefined ? {} : { label }) });
  };
  if (period === 'hour') {
    const p = localParts(zone, from);
    let start = zonedInstant(zone, { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: 0 });
    // Each next hour is the next wall-clock hour's instant; one-hour steps also work across DST because offsets change by whole hours in practice
    while (start < to) {
      const end = start + 3_600_000;
      push(start, end);
      start = end;
    }
    return out;
  }
  // Start one day early: a shift (or day) that began yesterday may still be running at `from`
  let day = addDays(productionDayOf(zone, from, dayStartHour), -1);
  for (let guard = 0; guard < 400; guard++) {
    const window = dayWindow(zone, day, dayStartHour);
    if (window.start >= to) break;
    if (period === 'day') push(window.start, window.end);
    else for (const shift of shifts) {
      const w = shiftWindow(zone, day, shift);
      push(w.start, w.end, shift.name);
    }
    day = addDays(day, 1);
  }
  return out.sort((a, b) => a.start - b.start);
}
