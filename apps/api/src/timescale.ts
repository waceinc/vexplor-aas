/**
 * TimescaleDB features for collected values on a site server (lead request §6 H2, 2026-10-16): compression of old
 * chunks and two continuous aggregates — `collected_value_1m` and `collected_value_1h` (avg · min · max · last · count
 * per package, interface and property).
 *
 *   COLLECT_COMPRESS_AFTER_DAYS   compress chunks older than this (default 7; 0 = no compression policy)
 *   COLLECT_ROLLUPS               off = no aggregates (default on)
 *   COLLECT_ROLLUP_MINUTE_DAYS    how long the 1-minute aggregate is kept (default 90; 0 = forever). 1-hour is kept forever
 *
 * Important: everything here needs **TimescaleDB Community Edition** (Timescale License, the `timescale/timescaledb`
 *    image). On plain PostgreSQL or **TimescaleDB Apache-2 Edition** (`-oss`) nothing is created and the server works as
 *    before — the startup log says so. Which edition a site gets is decided by the install bundle (make-release.sh).
 * Important: compression segments by package, interface and property, never by `value_key` — that key is unique per
 *    sample (`edge:<device>:<boot>:<seq>:<index>`), so segmenting by it would compress nothing. It is in the order instead,
 *    so a late batch is still checked against the unique index inside a compressed chunk (measured on 2.30.2).
 * Important: the aggregates refresh a window of `ROLLUP_WINDOW_DAYS` back, so a batch an edge kept for up to 30 days
 *    (contract §6, maxQueueDays) still lands in them. The window never reaches past the raw retention — refreshing a range
 *    whose raw values were deleted would empty the aggregate there.
 */
import { fill, tr } from '@aas/core';
import type { SqlClient } from '@aas/store';

/** Edge queue limit (30 days) plus a margin */
export const ROLLUP_WINDOW_DAYS = 35;

export interface TimescaleFeatures {
  compressAfterDays: number;
  rollups: boolean;
  rollupMinuteDays: number;
}

const days = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export function timescaleFeaturesFromEnv(env: NodeJS.ProcessEnv): TimescaleFeatures {
  return {
    compressAfterDays: days(env['COLLECT_COMPRESS_AFTER_DAYS'], 7),
    rollups: (env['COLLECT_ROLLUPS'] ?? '').trim().toLowerCase() !== 'off',
    rollupMinuteDays: days(env['COLLECT_ROLLUP_MINUTE_DAYS'], 90),
  };
}

/** How far back the aggregates refresh: the window above, but inside the raw retention (0 = forever) */
export function rollupWindowDays(retentionDays: number): number {
  return retentionDays > 0 ? Math.max(1, Math.min(ROLLUP_WINDOW_DAYS, Math.floor(retentionDays) - 1)) : ROLLUP_WINDOW_DAYS;
}

const rollupSql = (name: string, bucket: string): string => `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${name}
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT package_id, interface_name, property_name, time_bucket(INTERVAL '${bucket}', observed_at) AS bucket,
       avg(value_number) AS avg, min(value_number) AS min, max(value_number) AS max,
       last(value_number, observed_at) AS last, count(*) AS samples
  FROM collected_value
 GROUP BY package_id, interface_name, property_name, bucket
  WITH NO DATA`;

const interval = (value: number): string => `${value} days`;

/**
 * Sets the features up, idempotently, every start — a changed setting takes effect at the next start.
 * Call only after `collected_value` is a hypertable. Returns one line for the startup log.
 */
export async function setupTimescaleFeatures(client: SqlClient, features: TimescaleFeatures, retentionDays: number): Promise<string> {
  const { rows: license } = await client.query<{ license: string | null }>("SELECT current_setting('timescaledb.license', true) AS license");
  if (license[0]?.license !== 'timescale') return tr('압축 · 집계 없음 (TimescaleDB Apache-2 Edition)');

  const { rows: table } = await client.query<{ compression_enabled: boolean }>(
    "SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_schema = current_schema() AND hypertable_name = 'collected_value'",
  );
  if (table.length === 0) return tr('압축 · 집계 없음 (하이퍼테이블 아님)');

  const parts: string[] = [];
  await client.query("SELECT remove_compression_policy('collected_value'::regclass, if_exists => true)");
  if (features.compressAfterDays > 0) {
    if (!table[0]!.compression_enabled) {
      await client.query(
        "ALTER TABLE collected_value SET (timescaledb.compress, timescaledb.compress_segmentby = 'package_id, interface_name, property_name', timescaledb.compress_orderby = 'observed_at DESC, value_key')",
      );
    }
    await client.query('SELECT add_compression_policy($1::regclass, $2::interval)', ['collected_value', interval(features.compressAfterDays)]);
    parts.push(fill(tr('{0}일 지나면 압축'), { 0: features.compressAfterDays }));
  }

  if (features.rollups) {
    const window = rollupWindowDays(retentionDays);
    for (const [name, bucket, schedule] of [
      ['collected_value_1m', '1 minute', '1 minute'],
      ['collected_value_1h', '1 hour', '1 hour'],
    ] as const) {
      await client.query(rollupSql(name, bucket));
      await client.query('SELECT remove_continuous_aggregate_policy($1::regclass, if_not_exists => true)', [name]);
      await client.query('SELECT add_continuous_aggregate_policy($1::regclass, start_offset => $2::interval, end_offset => $3::interval, schedule_interval => $4::interval)', [
        name,
        interval(window),
        bucket,
        schedule,
      ]);
    }
    await client.query("SELECT remove_retention_policy('collected_value_1m'::regclass, if_exists => true)");
    if (features.rollupMinuteDays > 0) {
      // Never shorter than the refresh window — it would recompute what retention just dropped, again and again
      const keep = Math.max(features.rollupMinuteDays, window + 1);
      await client.query("SELECT add_retention_policy('collected_value_1m'::regclass, $1::interval)", [interval(keep)]);
    }
    parts.push(fill(tr('1분 · 1시간 집계 ({0}일 뒤까지 반영)'), { 0: window }));
  } else {
    // Turned off after having been on: the views stay (their data is kept) but stop refreshing
    for (const name of ['collected_value_1m', 'collected_value_1h']) {
      const { rows } = await client.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
      if (rows[0]?.present) await client.query('SELECT remove_continuous_aggregate_policy($1::regclass, if_not_exists => true)', [name]);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : tr('압축 · 집계 끔');
}
