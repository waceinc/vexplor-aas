/**
 * Numbers of a collector's state, written for a person: sizes, durations, clock offsets, shares.
 *
 * Important: "—" means "no value", never 0 — a collector that does not send a value must not look like it sent zero.
 */
import { fill, locale, tr } from '../../i18n.js';

export const NONE = '—';

const number = (value: number, digits = 1): string => value.toLocaleString(locale(), { maximumFractionDigits: digits });

export function percent(value: number | undefined, digits = 1): string {
  return value === undefined ? NONE : `${number(value, digits)}%`;
}

/** 0–1 → "97.5%" */
export function ratio(value: number | undefined): string {
  return value === undefined ? NONE : `${number(value * 100, 1)}%`;
}

export function millis(value: number | undefined): string {
  return value === undefined ? NONE : `${number(value, 0)} ms`;
}

export function bytes(value: number | undefined): string {
  if (value === undefined) return NONE;
  const gb = value / 1024 ** 3;
  return gb >= 1 ? `${number(gb, 1)} GB` : `${number(value / 1024 ** 2, 0)} MB`;
}

/** Seconds → "3일 4시간", "2시간 5분", "45분", "30초" */
export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return NONE;
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  if (days > 0) return fill(tr('{0}일 {1}시간'), { 0: String(days), 1: String(hours) });
  if (hours > 0) return fill(tr('{0}시간 {1}분'), { 0: String(hours), 1: String(minutes) });
  if (minutes > 0) return fill(tr('{0}분'), { 0: String(minutes) });
  return fill(tr('{0}초'), { 0: String(s) });
}

/** Server minus PC clock, ms → "서버보다 1.2초 늦음" / "서버보다 0.3초 빠름" */
export function clockOffset(ms: number | undefined): string {
  if (ms === undefined) return NONE;
  const seconds = number(Math.abs(ms) / 1000, 1);
  if (Math.abs(ms) < 50) return tr('서버와 같음');
  // Positive: the server is ahead, so the PC is behind
  return ms > 0 ? fill(tr('서버보다 {0}초 늦음'), { 0: seconds }) : fill(tr('서버보다 {0}초 빠름'), { 0: seconds });
}
