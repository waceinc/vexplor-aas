/**
 * Tag pattern — creates many tags from a base name, an address template, and a number range (the bulk tag creation concept from digital-twin).
 *
 * In the template, {n} is the number (from start, by step) and {i} is the ordinal (from 1). Giving a width like {n:3} zero-pads the front.
 * e.g. name Zone{i}_Temp · address ns=1;s=Zone{n:2}.Temp · 1–4 → Zone1_Temp(ns=1;s=Zone01.Temp) …
 *     Modbus: name Temp_{i} · address {n} · 100–106 step 2 → Temp_1(100) · Temp_2(102) …
 */
export interface PatternInput {
  name: string;
  href: string;
  from: number;
  to: number;
  step: number;
}

export const PATTERN_LIMIT = 500;

function fillTemplate(template: string, n: number, i: number): string {
  return template.replace(/\{([ni])(?::(\d+))?\}/g, (_, key: string, width?: string) => {
    const value = String(key === 'n' ? n : i);
    return width ? value.padStart(Number(width), '0') : value;
  });
}

/** Expanded result — if the template has no {n}/{i} or the range is invalid, give the reason (create nothing) */
export function expandPattern(input: PatternInput): { rows: { name: string; href: string }[]; problem?: string } {
  if (!/\{[ni](?::\d+)?\}/.test(input.name)) return { rows: [], problem: 'name' };
  if (![input.from, input.to, input.step].every(Number.isInteger) || input.step < 1 || input.to < input.from) return { rows: [], problem: 'range' };
  const count = Math.floor((input.to - input.from) / input.step) + 1;
  if (count > PATTERN_LIMIT) return { rows: [], problem: 'too-many' };
  const rows = Array.from({ length: count }, (_, index) => {
    const n = input.from + index * input.step;
    return { name: fillTemplate(input.name, n, index + 1), href: fillTemplate(input.href, n, index + 1) };
  });
  return { rows };
}
