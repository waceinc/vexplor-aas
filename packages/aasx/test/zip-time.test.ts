/**
 * The same content gives the same ZIP bytes on every machine — whatever its time zone.
 *
 * ZIP keeps a local DOS date and time. Before zipTime, a file written in Seoul differed from the same file written on a
 * UTC server, so a bundle hash checked on one machine failed on the other (2026-10-16).
 */
import { readAasx, writeAasx, zipArchive, DETERMINISTIC_MTIME } from '@aas/aasx';
import { afterEach, describe, expect, it } from 'vitest';
import { GOLDEN, loadFixture } from './fixtures.js';

const ZONES = ['UTC', 'Asia/Seoul', 'America/New_York', 'Pacific/Chatham'];
const saved = process.env['TZ'];

afterEach(() => {
  if (saved === undefined) delete process.env['TZ'];
  else process.env['TZ'] = saved;
});

function inEachZone(make: () => Uint8Array): Uint8Array[] {
  return ZONES.map((zone) => {
    process.env['TZ'] = zone;
    return make();
  });
}

/** DOS time and date of the first local file header (offsets 10 and 12) */
function dosStamp(zip: Uint8Array): { time: number; date: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  return { time: view.getUint16(10, true), date: view.getUint16(12, true) };
}

describe('ZIP time', () => {
  it('writes the same bundle bytes in every time zone', () => {
    const files = { 'manifest.json': new TextEncoder().encode('{"a":1}\n'), 'b/c.json': new TextEncoder().encode('[]\n') };
    const outputs = inEachZone(() => zipArchive(files));
    for (const output of outputs) expect(Buffer.from(output).equals(Buffer.from(outputs[0]!))).toBe(true);
  });

  it('writes the same AASX bytes in every time zone', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    const outputs = inEachZone(() => writeAasx(pkg));
    for (const output of outputs) expect(Buffer.from(output).equals(Buffer.from(outputs[0]!))).toBe(true);
  });

  it('stores the UTC wall clock of the fixed time (2026-01-01 00:00)', () => {
    expect(new Date(DETERMINISTIC_MTIME).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    process.env['TZ'] = 'Asia/Seoul';
    const { time, date } = dosStamp(zipArchive({ 'a.json': new Uint8Array([1]) }));
    expect(time).toBe(0);
    expect(date).toBe(((2026 - 1980) << 9) | (1 << 5) | 1);
  });
});
