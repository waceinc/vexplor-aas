/**
 * CSV 한 칸 — 화면에서 내려받는 표(주소 목록 · 문서용 표 · 연계 정의 · 수집값)가 함께 쓴다.
 *
 * 🔴 **엑셀 수식 주입(CSV Injection)을 막는다**(2026-10-08 보안 점검). 남이 만든 AASX의 값이
 *    `=HYPERLINK(...)`·`+cmd|...`처럼 시작하면, 받은 표를 엑셀로 여는 사람의 PC에서 수식으로
 *    돌아간다. 그런 칸은 앞에 작은따옴표(')를 붙여 글자로 만든다(OWASP 권고).
 *    음수 같은 **숫자**(-12.5)는 그대로 둔다 — 값이 바뀌면 표를 쓰는 의미가 없다.
 */
export function csvCell(value: string, quote: 'always' | 'needed' = 'needed'): string {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) text = `'${text}`;
  return quote === 'always' || /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
