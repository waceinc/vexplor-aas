/**
 * 수집 실행 — AID가 말한 주소를 읽어 시계열로 흘린다.
 *
 * 프로토콜 구현(node-opcua 등)을 직접 의존하지 않고 `ProtocolReader` 포트만 받는다.
 * 저장소가 `SqlClient`만 받는 것과 같은 이유다 — 이 패키지는 순수 로직이라
 * 장비 없이도 시험할 수 있어야 하고, 라이선스 검토 대상도 늘리지 않는다.
 */
import type { AidInterface } from './aid.js';
import { readableProperties } from './aid.js';
import type { ProtocolReader, SampleSink, ValueSample } from './types.js';

export interface CollectOptions {
  packageId: string;
  /** 시각을 주입한다 — 시험에서 결정론적으로 쓰기 위해 */
  now?: () => string;
}

export interface CollectReport {
  /** 쌓은 표본 수 */
  collected: number;
  /** 읽지 못한 것 — 주소·품질 문제를 숨기지 않는다 */
  failures: { propertyName: string; source: string; reason: string }[];
  /**
   * 🔴 **아직 값이 안 들어온 것** — 실패가 아니다(`ReadResult.pending` 참조).
   * 시계열에도 넣지 않는다. 「무엇이 아직 안 왔는지」는 알려 주되 값은 만들지 않는다.
   *
   * 비어 있으면 아예 싣지 않는다. 이 보고는 `/packages/:id/collect` 응답으로 그대로 나가고,
   * `failures`만 세던 예전 소비자를 깨뜨리지 않으려면 없던 칸이 조용히 생겨야 한다.
   */
  pending?: { propertyName: string; source: string; reason: string }[];
  /** 주소가 없어 건너뛴 항목 */
  skipped: string[];
}

/** 값이 숫자면 숫자로, 아니면 문자열로 담는다. 시계열 질의가 갈라지기 때문이다 */
export function toSample(
  base: Omit<ValueSample, 'valueNumber' | 'valueText'>,
  value: unknown,
): ValueSample {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { ...base, valueNumber: value };
  }
  if (typeof value === 'boolean') return { ...base, valueNumber: value ? 1 : 0, valueText: String(value) };
  if (value === null || value === undefined) return { ...base, valueText: '' };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const parsed = Number(text);
  return Number.isFinite(parsed) && text.trim() !== ''
    ? { ...base, valueNumber: parsed, valueText: text }
    : { ...base, valueText: text };
}

export async function collectOnce(
  descriptor: AidInterface,
  reader: ProtocolReader,
  sink: SampleSink,
  options: CollectOptions,
): Promise<CollectReport> {
  const now = options.now ?? ((): string => new Date().toISOString());
  const readable = readableProperties(descriptor);
  const skipped = descriptor.properties
    .filter((property) => property.href === undefined)
    .map((property) => property.name);

  if (readable.length === 0) return { collected: 0, failures: [], skipped };

  const bySource = new Map(readable.map((property) => [property.href!, property]));
  const results = await reader.read([...bySource.keys()]);

  const samples: ValueSample[] = [];
  const failures: CollectReport['failures'] = [];
  const pending: NonNullable<CollectReport['pending']> = [];

  for (const result of results) {
    const property = bySource.get(result.source);
    if (!property) continue;
    if (result.error !== undefined) {
      failures.push({ propertyName: property.name, source: result.source, reason: result.error });
      continue;
    }
    // 🔴 값이 아직 없는 것은 **표본으로 만들지 않는다.** `toSample(null)`은 빈 문자열을 남기는데,
    //    그러면 "그 시각에 빈 값이 관측됐다"는 가짜 이력이 시계열에 쌓인다. 실패로도 세지 않는다
    if (result.pending === true) {
      pending.push({
        propertyName: property.name,
        source: result.source,
        reason: result.quality ?? '값 대기',
      });
      continue;
    }
    samples.push(
      toSample(
        {
          packageId: options.packageId,
          interfaceName: descriptor.name,
          propertyName: property.name,
          source: result.source,
          observedAt: result.observedAt ?? now(),
          ...(result.quality === undefined ? {} : { quality: result.quality }),
        },
        result.value,
      ),
    );
  }

  if (samples.length > 0) await sink.append(samples);
  return {
    collected: samples.length,
    failures,
    ...(pending.length > 0 ? { pending } : {}),
    skipped,
  };
}
