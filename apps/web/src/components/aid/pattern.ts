/**
 * 태그 패턴 — 기준 이름 · 주소 틀과 번호 범위로 태그를 여러 개 만든다(digital-twin 의 태그 일괄 생성 개념).
 *
 * 틀 안의 {n} 은 번호(시작부터 간격씩), {i} 는 몇 번째인지(1부터)다. {n:3} 처럼 자리수를 주면 앞을 0 으로 채운다.
 * 예: 이름 Zone{i}_Temp · 주소 ns=1;s=Zone{n:2}.Temp · 1~4 → Zone1_Temp(ns=1;s=Zone01.Temp) …
 *     Modbus: 이름 Temp_{i} · 주소 {n} · 100~106 간격 2 → Temp_1(100) · Temp_2(102) …
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

/** 펼친 결과 — 틀에 {n}·{i} 가 없거나 범위가 이상하면 이유를 준다(만들지 않는다) */
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
