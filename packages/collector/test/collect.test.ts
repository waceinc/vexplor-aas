/**
 * Collection run tests — without equipment.
 *
 * Because protocol adapters sit behind a port, the whole flow can run with a fake reader.
 * Tests against a real OPC UA server live separately on the adapter side (apps).
 */
import { collectOnce, toSample, type AidInterface, type ProtocolReader, type ValueSample } from '@aas/collector';
import { describe, expect, it } from 'vitest';

const descriptor: AidInterface = {
  name: 'InterfaceTemplateForOPCUA',
  protocol: 'OPCUA',
  base: 'opc.tcp://192.168.0.10:4840',
  properties: [
    { name: 'MotorSpeed', href: 'ns=2;s=Speed', observable: true, formFields: {}, type: 'float' },
    { name: 'AlarmActive', href: 'ns=2;s=Alarm', observable: false, formFields: {} },
    { name: '주소없음', observable: false, formFields: {} },
  ],
};

function reader(results: { source: string; value?: unknown; error?: string; quality?: string }[]): ProtocolReader {
  return {
    base: descriptor.base!,
    async read(sources) {
      return sources.map((source) => {
        const found = results.find((r) => r.source === source);
        return found ? { ...found, source } : { source, error: '응답 없음' };
      });
    },
    async close() {},
  };
}

const sink = (): { samples: ValueSample[]; append: (s: readonly ValueSample[]) => Promise<void> } => {
  const samples: ValueSample[] = [];
  return {
    samples,
    append: async (batch) => {
      samples.push(...batch);
    },
  };
};

describe('Collection run', () => {
  it('reads only the addresses the AID declares and stores them as samples', async () => {
    const target = sink();
    const report = await collectOnce(
      descriptor,
      reader([
        { source: 'ns=2;s=Speed', value: 1234.5, quality: 'Good' },
        { source: 'ns=2;s=Alarm', value: false },
      ]),
      target,
      { packageId: 'pkg_1', now: () => '2026-08-24T00:00:00.000Z' },
    );

    expect(report.collected).toBe(2);
    expect(report.skipped).toEqual(['주소없음']); // no address means nothing to read
    expect(report.failures).toEqual([]);

    expect(target.samples[0]).toEqual({
      packageId: 'pkg_1',
      interfaceName: 'InterfaceTemplateForOPCUA',
      propertyName: 'MotorSpeed',
      source: 'ns=2;s=Speed',
      observedAt: '2026-08-24T00:00:00.000Z',
      receivedAt: '2026-08-24T00:00:00.000Z',
      quality: 'Good',
      valueNumber: 1234.5,
    });
  });

  it('uses the device timestamp when provided — not the collector clock', async () => {
    const target = sink();
    await collectOnce(
      descriptor,
      reader([{ source: 'ns=2;s=Speed', value: 1, observedAt: '2026-01-01T00:00:00.000Z' } as never]),
      target,
      { packageId: 'pkg_1', now: () => '2026-08-24T00:00:00.000Z' },
    );
    expect(target.samples[0]!.observedAt).toBe('2026-01-01T00:00:00.000Z');
    // Important: receive time comes from this tool's clock — records "just read" even if the device clock is stuck (freshness check)
    expect(target.samples[0]!.receivedAt).toBe('2026-08-24T00:00:00.000Z');
  });

  it('reports unreadable items with a reason instead of hiding them', async () => {
    const target = sink();
    const report = await collectOnce(descriptor, reader([{ source: 'ns=2;s=Speed', value: 10 }]), target, {
      packageId: 'pkg_1',
    });

    expect(report.collected).toBe(1);
    expect(report.failures).toEqual([
      { propertyName: 'AlarmActive', source: 'ns=2;s=Alarm', reason: '응답 없음' },
    ]);
  });

  it('does not touch the store when there is nothing to read', async () => {
    const target = sink();
    const empty: AidInterface = { name: 'X', protocol: 'OPCUA', properties: [] };
    const report = await collectOnce(empty, reader([]), target, { packageId: 'pkg_1' });
    expect(report).toEqual({ collected: 0, failures: [], skipped: [] });
    expect(target.samples).toHaveLength(0);
  });
});

describe('Value storage', () => {
  const base = {
    packageId: 'p',
    interfaceName: 'i',
    propertyName: 'n',
    observedAt: '2026-08-24T00:00:00.000Z',
  };

  it('numbers go in the numeric column — time-series queries depend on it', () => {
    expect(toSample(base, 12.5).valueNumber).toBe(12.5);
    expect(toSample(base, '42').valueNumber).toBe(42);
    expect(toSample(base, '42').valueText).toBe('42');
  });

  it('booleans go in both numeric and text columns — for aggregation and display', () => {
    const sample = toSample(base, true);
    expect(sample.valueNumber).toBe(1);
    expect(sample.valueText).toBe('true');
  });

  it('non-numbers go in the text column', () => {
    expect(toSample(base, 'RUNNING')).toMatchObject({ valueText: 'RUNNING' });
    expect(toSample(base, { a: 1 }).valueText).toBe('{"a":1}');
    expect(toSample(base, null).valueText).toBe('');
  });

  it('does not store NaN or Infinity as numbers — they pollute the time series', () => {
    expect(toSample(base, Number.NaN).valueNumber).toBeUndefined();
    expect(toSample(base, Number.POSITIVE_INFINITY).valueNumber).toBeUndefined();
  });
});
