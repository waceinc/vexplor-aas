/**
 * Nesting depth of JSON text, measured without recursion (red-team L7, 2026-10-16).
 *
 * Important: this must run **before** anything recursive touches the input. A depth check inside a recursive walk only
 *    helps if the walk gets that far — on a runner with a smaller stack (the Linux CI machines), JSON.stringify,
 *    structuredClone or a recursive validator overflowed first and the cap never ran. Counting brackets in the text is
 *    one loop, so the stack size does not matter.
 */

/**
 * True when the text nests objects/arrays deeper than `max`. Brackets inside strings (and escaped quotes) are ignored.
 * Malformed text is not judged here — JSON.parse reports that afterwards.
 */
export function jsonDepthExceeds(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) i += 1; // skip the escaped character, whatever it is
      else if (c === 0x22 /* " */) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
      depth += 1;
      if (depth > max) return true;
    } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) depth -= 1;
  }
  return false;
}
