/**
 * How the server judges a remote collector (2.8.0): OK, Attention or Problem, with the reasons. One function decides it
 * for the screen and the documents — the thresholds sit in one constant, and the guides must state the same numbers.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { EDGE_HEALTH_THRESHOLDS as T, judgeEdge, pointOf, type EdgeHistoryPoint } from '../src/edge/health.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

/** The status of a healthy 1.1.0 collector, with one change */
function status(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startedAt: ago(3_600_000),
    queuedBatches: 0,
    droppedBatches: 0,
    software: { name: 'vexplor-edge', version: '1.1.0' },
    interfaces: [{ interfaceId: 'pkg_1:OPCUA', connected: true, lastError: null, responseMs: 12, readOkRatio: 1, reconnects: 0, lastDisconnectAt: null }],
    host: { cpuPercent: 5, memoryUsedPercent: 40, diskFreeBytes: 5e10, diskFreePercent: 70, uptimeSeconds: 9000, processUptimeSeconds: 3600, clockOffsetMs: -120, queuedInMemory: 0 },
    server: { lastSendOkAt: ago(5_000), lastSendError: null, lastSendErrorAt: null, sendFailuresSinceOk: 0, roundTripMs: 60, oldestQueuedAt: null },
    ...change,
  };
}
const host = (change: Record<string, unknown>) => ({ host: { ...(status()['host'] as object), ...change } });
const server = (change: Record<string, unknown>) => ({ server: { ...(status()['server'] as object), ...change } });
const link = (change: Record<string, unknown>) => ({ interfaces: [{ ...(status()['interfaces'] as object[])[0], ...change }] });

const judge = (lastStatus: Record<string, unknown> | null, more: { lastSeenAt?: string; statusAt?: string; history?: EdgeHistoryPoint[] } = {}) =>
  judgeEdge({ lastSeenAt: more.lastSeenAt ?? ago(5_000), statusAt: more.statusAt ?? ago(5_000), lastStatus, history: more.history ?? [] }, NOW)!;
const codes = (verdict: ReturnType<typeof judge>) => verdict?.reasons.map((reason) => reason.code);

describe('judgeEdge — thresholds and their edges', () => {
  it('a healthy 1.1.0 collector is OK with no reasons', () => {
    expect(judge(status())).toEqual({ level: 'ok', reasons: [] });
  });

  it('never heard from: nothing to judge', () => {
    expect(judgeEdge({ lastSeenAt: null, lastStatus: null, history: [] }, NOW)).toBeNull();
  });

  it('silent: problem only past the "silent" limit', () => {
    expect(judge(status(), { lastSeenAt: ago(T.silentAfterMs) }).level).toBe('ok');
    const silent = judge(status(), { lastSeenAt: ago(T.silentAfterMs + 1) });
    expect(silent.level).toBe('problem');
    expect(codes(silent)).toEqual(['silent']);
  });

  it('disk: attention under 10 %, problem under 2 %', () => {
    expect(judge(status(host({ diskFreePercent: T.diskFreeAttentionPercent }))).level).toBe('ok');
    expect(codes(judge(status(host({ diskFreePercent: 9.9 }))))).toEqual(['disk-low']);
    expect(judge(status(host({ diskFreePercent: 9.9 }))).level).toBe('attention');
    expect(codes(judge(status(host({ diskFreePercent: T.diskFreeProblemPercent }))))).toEqual(['disk-low']);
    const full = judge(status(host({ diskFreePercent: 1.9 })));
    expect(full.level).toBe('problem');
    expect(codes(full)).toEqual(['disk-full']);
  });

  it('equipment: problem when none of n is connected; one of two is not a problem by itself', () => {
    const none = judge(status({ interfaces: [{ interfaceId: 'a', connected: false, lastError: 'ECONNREFUSED' }, { interfaceId: 'b', connected: false }] }));
    expect(none.level).toBe('problem');
    expect(codes(none)).toContain('no-equipment');
    expect(none.reasons[0]!.message).toMatch(/0\/2/);
    const one = judge(status({ interfaces: [{ interfaceId: 'a', connected: true }, { interfaceId: 'b', connected: false }] }));
    expect(codes(one)).not.toContain('no-equipment');
    // A collector with an empty list reads nothing — that is not "no equipment"
    expect(codes(judge(status({ interfaces: [] })))).toEqual([]);
  });

  it('sending: attention once failures last longer than 1 minute', () => {
    const at = (failingFor: number) =>
      judge(status(server({ lastSendOkAt: ago(5_000 + failingFor), sendFailuresSinceOk: 3, lastSendError: 'no answer: ETIMEDOUT' })));
    expect(at(T.sendFailingAttentionMs).level).toBe('ok');
    const failing = at(T.sendFailingAttentionMs + 1);
    expect(codes(failing)).toEqual(['send-failing']);
    expect(failing.reasons[0]!.message).toMatch(/ETIMEDOUT/);
    // No failure counted: a long time since the last OK alone is not a failure
    expect(judge(status(server({ lastSendOkAt: ago(3_600_000), sendFailuresSinceOk: 0 }))).level).toBe('ok');
    // Never sent OK since it started: measured from the start
    expect(codes(judge(status({ ...server({ lastSendOkAt: null, sendFailuresSinceOk: 2 }), startedAt: ago(120_000) })))).toEqual(['send-failing']);
  });

  it('clock: attention when the offset is more than 5 s either way', () => {
    expect(judge(status(host({ clockOffsetMs: T.clockOffsetAttentionMs }))).level).toBe('ok');
    expect(judge(status(host({ clockOffsetMs: -T.clockOffsetAttentionMs }))).level).toBe('ok');
    expect(codes(judge(status(host({ clockOffsetMs: 5_001 }))))).toEqual(['clock-offset']);
    expect(codes(judge(status(host({ clockOffsetMs: -5_001 }))))).toEqual(['clock-offset']);
  });

  it('reads: attention when an interface succeeds less than 90 % of the time', () => {
    expect(judge(status(link({ readOkRatio: T.readOkAttentionRatio }))).level).toBe('ok');
    const low = judge(status(link({ readOkRatio: 0.89 })));
    expect(codes(low)).toEqual(['read-ok-low']);
    expect(low.reasons[0]!.message).toMatch(/pkg_1:OPCUA/);
    expect(low.reasons[0]!.interfaceId).toBe('pkg_1:OPCUA');
  });

  it('queue: a recent failed write and batches waiting in memory are attention', () => {
    expect(codes(judge(status(host({ queueWriteError: 'ENOSPC: no space left', queueWriteErrorAt: ago(60_000) }))))).toEqual(['queue-write-failed']);
    // Long recovered: the edge keeps the last error, the server stops warning after an hour
    expect(judge(status(host({ queueWriteError: 'ENOSPC', queueWriteErrorAt: ago(T.queueWriteRecentMs + 5_001) }))).level).toBe('ok');
    expect(codes(judge(status(host({ queuedInMemory: 1 }))))).toEqual(['queue-in-memory']);
    expect(judge(status(host({ queuedInMemory: 0 }))).level).toBe('ok');
  });

  it('dropped batches: attention when the count went up within the last hour, also across a restart', () => {
    const point = (msAgo: number, dropped: number): EdgeHistoryPoint => ({ at: ago(msAgo), values: 0, dropped });
    expect(judge(status({ droppedBatches: 4 }), { history: [point(1_800_000, 4), point(60_000, 4)] }).level).toBe('ok');
    const grew = judge(status({ droppedBatches: 6 }), { history: [point(1_800_000, 4), point(60_000, 6)] });
    expect(codes(grew)).toEqual(['batches-dropped']);
    expect(grew.reasons[0]!.message).toMatch(/2/);
    // Restarted (count back to 0), then dropped 1 — still an increase
    expect(codes(judge(status({ droppedBatches: 1 }), { history: [point(1_800_000, 4), point(900_000, 0), point(60_000, 1)] }))).toEqual(['batches-dropped']);
    // Older than an hour does not count
    expect(judge(status({ droppedBatches: 6 }), { history: [point(T.droppedWindowMs + 600_000, 4), point(T.droppedWindowMs + 300_000, 6)] }).level).toBe('ok');
  });

  it('problems come first, and the level is the worst reason', () => {
    const verdict = judge(status({ ...host({ diskFreePercent: 1, clockOffsetMs: 9_000 }) }), { lastSeenAt: ago(T.silentAfterMs + 60_000) });
    expect(verdict.level).toBe('problem');
    expect(codes(verdict)).toEqual(['silent', 'disk-full', 'clock-offset']);
  });

  it('an edge 1.0.x status (no host, no server, no per-link numbers) is judged on what it has', () => {
    const old = { startedAt: ago(60_000), queuedBatches: 0, droppedBatches: 0, software: { name: 'vexplor-edge', version: '1.0.1' }, interfaces: [{ interfaceId: 'a', connected: true, lastError: null }] };
    expect(judge(old)).toEqual({ level: 'ok', reasons: [] });
    expect(judge({ ...old, interfaces: [{ interfaceId: 'a', connected: false, lastError: 'x' }] }).level).toBe('problem');
  });

  it('values of the wrong type from a device are ignored, not trusted', () => {
    expect(judge(status({ host: { diskFreePercent: '1', clockOffsetMs: 'far' }, server: 'broken', interfaces: 'x' })).level).toBe('ok');
  });
});

describe('history points', () => {
  it('keep the numbers the trend needs, compactly', () => {
    const point = pointOf(status(link({ readOkRatio: 0.95 })), ago(0), 7);
    expect(point).toEqual({
      at: NOW.toISOString(),
      values: 7,
      cpu: 5,
      mem: 40,
      disk: 70,
      clock: -120,
      rtt: 60,
      queued: 0,
      memQueued: 0,
      dropped: 0,
      fails: 0,
      links: [{ id: 'pkg_1:OPCUA', up: true, ratio: 0.95, ms: 12 }],
    });
    expect(pointOf(null, ago(0), 3)).toEqual({ at: NOW.toISOString(), values: 3 });
  });
});

describe('the guides state the same thresholds', () => {
  it.each([
    ['docs/usage.md', '8-8'],
    ['docs/사용법.md', '8-8'],
  ])('%s', (file) => {
    const text = readFileSync(file, 'utf8');
    const table = text.slice(text.indexOf('<!-- edge-health-thresholds -->'), text.indexOf('<!-- /edge-health-thresholds -->'));
    expect(table.length).toBeGreaterThan(100);
    for (const value of [
      `${T.diskFreeAttentionPercent}%`,
      `${T.diskFreeProblemPercent}%`,
      `${T.sendFailingAttentionMs / 60_000}`,
      `${T.clockOffsetAttentionMs / 1000}`,
      `${T.readOkAttentionRatio * 100}%`,
      `${T.silentAfterMs / 60_000}`,
    ]) {
      expect(table, value).toContain(value);
    }
  });
});
