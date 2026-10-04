/**
 * 수집 실행 검증 — 장비 없이.
 *
 * 프로토콜 어댑터를 포트로 뺀 덕에 가짜 리더로 전 과정을 돌릴 수 있다.
 * 실제 OPC UA 서버를 상대로 하는 시험은 어댑터 쪽(apps)에서 따로 한다.
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

describe('수집 실행', () => {
  it('AID가 말한 주소만 읽어 표본으로 쌓는다', async () => {
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
    expect(report.skipped).toEqual(['주소없음']); // 주소가 없으면 읽을 곳이 없다
    expect(report.failures).toEqual([]);

    expect(target.samples[0]).toEqual({
      packageId: 'pkg_1',
      interfaceName: 'InterfaceTemplateForOPCUA',
      propertyName: 'MotorSpeed',
      source: 'ns=2;s=Speed',
      observedAt: '2026-08-24T00:00:00.000Z',
      quality: 'Good',
      valueNumber: 1234.5,
    });
  });

  it('장비가 준 시각이 있으면 그것을 쓴다 — 수집기 시계가 아니라', async () => {
    const target = sink();
    await collectOnce(
      descriptor,
      reader([{ source: 'ns=2;s=Speed', value: 1, observedAt: '2026-01-01T00:00:00.000Z' } as never]),
      target,
      { packageId: 'pkg_1', now: () => '2026-08-24T00:00:00.000Z' },
    );
    expect(target.samples[0]!.observedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('읽지 못한 것은 숨기지 않고 사유와 함께 남긴다', async () => {
    const target = sink();
    const report = await collectOnce(descriptor, reader([{ source: 'ns=2;s=Speed', value: 10 }]), target, {
      packageId: 'pkg_1',
    });

    expect(report.collected).toBe(1);
    expect(report.failures).toEqual([
      { propertyName: 'AlarmActive', source: 'ns=2;s=Alarm', reason: '응답 없음' },
    ]);
  });

  it('읽을 것이 하나도 없으면 저장소를 건드리지 않는다', async () => {
    const target = sink();
    const empty: AidInterface = { name: 'X', protocol: 'OPCUA', properties: [] };
    const report = await collectOnce(empty, reader([]), target, { packageId: 'pkg_1' });
    expect(report).toEqual({ collected: 0, failures: [], skipped: [] });
    expect(target.samples).toHaveLength(0);
  });
});

describe('값 담기', () => {
  const base = {
    packageId: 'p',
    interfaceName: 'i',
    propertyName: 'n',
    observedAt: '2026-08-24T00:00:00.000Z',
  };

  it('숫자는 숫자 칸에 — 시계열 질의가 갈린다', () => {
    expect(toSample(base, 12.5).valueNumber).toBe(12.5);
    expect(toSample(base, '42').valueNumber).toBe(42);
    expect(toSample(base, '42').valueText).toBe('42');
  });

  it('참·거짓은 숫자와 글자 양쪽에 담는다 — 집계도 표시도 되게', () => {
    const sample = toSample(base, true);
    expect(sample.valueNumber).toBe(1);
    expect(sample.valueText).toBe('true');
  });

  it('숫자가 아닌 것은 글자로', () => {
    expect(toSample(base, 'RUNNING')).toMatchObject({ valueText: 'RUNNING' });
    expect(toSample(base, { a: 1 }).valueText).toBe('{"a":1}');
    expect(toSample(base, null).valueText).toBe('');
  });

  it('NaN·Infinity는 숫자로 담지 않는다 — 시계열이 오염된다', () => {
    expect(toSample(base, Number.NaN).valueNumber).toBeUndefined();
    expect(toSample(base, Number.POSITIVE_INFINITY).valueNumber).toBeUndefined();
  });
});
