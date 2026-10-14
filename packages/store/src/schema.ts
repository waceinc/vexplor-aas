/**
 * Version 9 (2026-10-14) — integration: event log (outbox), subscriptions, deliveries, configuration, external
 * references and runtime state (docs/design/integration-v1.md §3.4). The same text is the v9 migration and the tail
 * of `SCHEMA_SQL`, so the two cannot drift.
 *
 * Important: no semicolon inside a comment or a string literal here — `runStatements` splits the script on it.
 * Important: `integration_event.package_id` has **no** foreign key. Events outlive their package (a consumer must still
 *    receive `model.package.deleted` and replay history after the package is gone).
 */
export const INTEGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS integration_event (
  seq              bigserial PRIMARY KEY,
  id               text NOT NULL UNIQUE,
  type             text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  package_id       text,
  subject          text,
  package_revision integer,
  owner            text,
  actor_id         text,
  actor_name       text,
  cause            text,
  change_set_id    text,
  data             jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS integration_event_recorded_idx ON integration_event (recorded_at);
CREATE INDEX IF NOT EXISTS integration_event_pkg_idx ON integration_event (package_id, seq);
CREATE INDEX IF NOT EXISTS integration_event_type_idx ON integration_event (type, seq);

CREATE TABLE IF NOT EXISTS integration_subscription (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('webhook', 'mqtt')),
  url                text NOT NULL,
  types              jsonb NOT NULL DEFAULT '[]'::jsonb,
  package_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled            boolean NOT NULL DEFAULT true,
  disabled_reason    text,
  options            jsonb NOT NULL DEFAULT '{}'::jsonb,
  key_id             text NOT NULL,
  secret_sealed      text NOT NULL,
  previous_sealed    text,
  previous_until     timestamptz,
  credentials_sealed text,
  secret_hint        text NOT NULL,
  consecutive_dead   integer NOT NULL DEFAULT 0,
  last_success_at    timestamptz,
  created_by         text,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_delivery (
  id               bigserial PRIMARY KEY,
  subscription_id  text NOT NULL REFERENCES integration_subscription(id) ON DELETE CASCADE,
  event_seq        bigint NOT NULL,
  event_id         text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'in-flight', 'succeeded', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  lease_until      timestamptz,
  last_status_code integer,
  last_error       text,
  last_duration_ms integer,
  last_address     text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (subscription_id, event_seq)
);
CREATE INDEX IF NOT EXISTS integration_delivery_due_idx ON integration_delivery (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS integration_config (
  scope       text PRIMARY KEY,
  package_id  text REFERENCES aas_package(id) ON DELETE CASCADE,
  value       jsonb NOT NULL,
  revision    integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL,
  actor_id    text,
  actor_name  text
);

CREATE TABLE IF NOT EXISTS external_ref_doc (
  package_id  text PRIMARY KEY REFERENCES aas_package(id) ON DELETE CASCADE,
  doc         jsonb NOT NULL,
  revision    integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL,
  actor_id    text,
  actor_name  text
);

CREATE TABLE IF NOT EXISTS external_ref_key (
  system      text NOT NULL,
  type        text NOT NULL,
  ref_id      text NOT NULL,
  package_id  text NOT NULL REFERENCES aas_package(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  PRIMARY KEY (system, type, ref_id)
);

CREATE TABLE IF NOT EXISTS integration_state (
  key         text PRIMARY KEY,
  package_id  text REFERENCES aas_package(id) ON DELETE CASCADE,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL
);
`;

/**
 * PostgreSQL schema (spec M1 · value sync Option A).
 *
 * The DDL is kept as a string rather than a file because file paths shift depending on the deployment
 * form (Docker image, bundle, serverless). When handing it to an operations DBA, just dump this constant.
 *
 * Design rationale is in docs/PROGRESS.md §2-2. In short:
 *  ① content (jsonb) is the original and the other columns are derived. If they disagree, the original wins.
 *  ② Without ordinal, a lossless export is not possible.
 *  ③ No UNIQUE on id — defective files must also be accepted without loss so the linter can flag them.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS aas_package (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  spec_part   text NOT NULL DEFAULT '/aasx/data.json',
  revision    integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Owner (workspace key). NULL = shared. On a server a team uses together, all rows are NULL
  owner       text
);
-- Important: the index on owner is **not here** (it is in MIGRATIONS version 6). On an old DB from before
--    version numbers, these statements run before the migrations - the table already exists and is skipped,
--    so creating only the index fails startup with "column does not exist". An index on a new column
--    goes in the same place that adds the column.

CREATE TABLE IF NOT EXISTS aas_package_file (
  package_id   text NOT NULL REFERENCES aas_package(id) ON DELETE CASCADE,
  part         text NOT NULL,
  role         text NOT NULL CHECK (role IN ('thumbnail', 'supplementary', 'extra', 'bundle')),
  content_type text NOT NULL,
  data         bytea NOT NULL,
  PRIMARY KEY (package_id, part)
);

CREATE TABLE IF NOT EXISTS app_user (
  id            text PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- Contact address (optional). Important: it is not verified - there is no mail server, and faking it is worse.
  --    No UNIQUE either: one person may hold two accounts, and there is no reason to forbid it
  email         text,
  -- Company name and personal-data consent time (version 7). Filled only by sign-ups on servers that publish a privacy policy
  company       text,
  consent_at    timestamptz
);

CREATE TABLE IF NOT EXISTS identifiable (
  uid         bigserial PRIMARY KEY,
  package_id  text NOT NULL REFERENCES aas_package(id) ON DELETE CASCADE,
  model_type  text NOT NULL CHECK (model_type IN ('AssetAdministrationShell', 'Submodel', 'ConceptDescription')),
  id          text NOT NULL,
  id_short    text,
  semantic_id text,
  asset_kind  text,
  kind        text,
  ordinal     integer NOT NULL,
  content     jsonb NOT NULL,
  revision    integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identifiable_order_idx ON identifiable (package_id, model_type, ordinal);
CREATE INDEX IF NOT EXISTS identifiable_id_idx ON identifiable (package_id, model_type, id);
CREATE INDEX IF NOT EXISTS identifiable_id_short_idx ON identifiable (package_id, id_short);
CREATE INDEX IF NOT EXISTS identifiable_semantic_idx ON identifiable (package_id, semantic_id);

CREATE TABLE IF NOT EXISTS identifiable_history (
  history_id  bigserial PRIMARY KEY,
  uid         bigint NOT NULL,
  package_id  text NOT NULL,
  model_type  text NOT NULL,
  id          text NOT NULL,
  revision    integer NOT NULL,
  content     jsonb NOT NULL,
  operation   text NOT NULL CHECK (operation IN ('update', 'delete')),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  -- Important: does **not** reference app_user. The audit record must survive account deletion,
  --    and the name is copied as it was at the time (renaming a person does not rewrite past records)
  actor_id    text,
  actor_name  text
);

CREATE INDEX IF NOT EXISTS identifiable_history_idx ON identifiable_history (package_id, model_type, id, history_id DESC);

CREATE TABLE IF NOT EXISTS collected_value (
  package_id     text NOT NULL REFERENCES aas_package(id) ON DELETE CASCADE,
  interface_name text NOT NULL,
  property_name  text NOT NULL,
  source         text,
  observed_at    timestamptz NOT NULL,
  value_number   double precision,
  value_text     text,
  quality        text,
  received_at    timestamptz
);

CREATE INDEX IF NOT EXISTS collected_value_idx ON collected_value (package_id, property_name, observed_at DESC);
${INTEGRATION_SCHEMA_SQL}`;

/**
 * Schema version number.
 *
 * The version of the tables is recorded in the DB itself. When an upgraded program meets an old DB it applies
 * `MIGRATIONS` in order, and conversely **if the DB is newer than the program, startup is refused** — old code
 * half-reading new tables and silently losing data is the worst kind of incident (basyx did that).
 *
 * Conventions:
 *  - `SCHEMA_SQL` is always the **complete form of the latest version** and idempotent (IF NOT EXISTS). An empty DB becomes current with this alone.
 *  - To bump the version: ① edit SCHEMA_SQL ② add the same change to `MIGRATIONS` as one more ALTER entry
 *    ③ bump `SCHEMA_VERSION`. A migration must turn the previous version's tables into the new version and must be idempotent.
 *  - An existing DB without `schema_version` is treated as version 1 (the tables as of 2026-09-04, when version numbers were introduced, are version 1).
 */
export const SCHEMA_VERSION = 9;

export const SCHEMA_VERSION_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

/**
 * Statements that upgrade from version n-1 → n. Version 1 is the baseline, so it has no entry.
 * Important: **must be idempotent** — they are re-run in order even on DBs from before version numbers were introduced (0).
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    // Version 2 (2026-09-30) — reference bundle attachments (role 'bundle'). The auto-generated column constraint name is <table>_<column>_check
    version: 2,
    sql: `
ALTER TABLE aas_package_file DROP CONSTRAINT IF EXISTS aas_package_file_role_check;
ALTER TABLE aas_package_file ADD CONSTRAINT aas_package_file_role_check
  CHECK (role IN ('thumbnail', 'supplementary', 'extra', 'bundle'));
`,
  },
  {
    /*
     * Version 3 (2026-10-02) — user accounts. Replaces a single shared token with per-person accounts.
     *
     * Important: **no sessions table.** There are three store implementations (memory, folder, postgres), so persisting
     *    sessions would mean touching all three, while this tool assumes a single server. Sessions live in that server's
     *    memory — restarting the server means logging in again. An acceptable cost on a closed network.
     * Important: passwords are stored **as hashes only** (scrypt, built into Node). The plaintext is kept nowhere.
     */
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS app_user (
  id            text PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- Contact address (optional). Important: it is not verified - there is no mail server, and faking it is worse.
  --    No UNIQUE either: one person may hold two accounts, and there is no reason to forbid it
  email         text
);
`,
  },
  {
    /*
     * Version 4 (2026-10-02) — the "who" of the audit log. Records the person who made each change in history.
     *
     * Important: **NULL is allowed.** History accumulated before this version has no changer. Filling it with
     *    any value other than "unknown" would invent facts that never existed.
     * Important: no foreign key — deleting an account must not make the audit log disappear with it.
     */
    version: 4,
    sql: `
ALTER TABLE identifiable_history ADD COLUMN IF NOT EXISTS actor_id   text;
ALTER TABLE identifiable_history ADD COLUMN IF NOT EXISTS actor_name text;
`,
  },
  {
    /*
     * Version 5 (2026-10-04) — sign-up. Contact details are accepted as **optional**.
     *
     * Important: NULL is allowed. Accounts created by an admin on an internal network have no contact details, and
     *    filling the missing value with an empty string would mix "not entered" with "empty value".
     * Important: this is personal data — once collected, a privacy policy, consent, retention period and disposal follow.
     *    That is why it was left **working without collecting it** (docs/deployment.md).
     */
    version: 5,
    sql: `
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email text;
`,
  },
  {
    /*
     * Version 6 (2026-10-04) — workspaces. Records an owner on each package.
     *
     * Important: **NULL means "shared".** Packages from before this version all become NULL, so upgrading an old DB
     *    **changes nothing** — everyone still sees everything, as before.
     *    Inventing owners to fill it would turn files that were being shared just fine into one person's property.
     * Important: does not reference app_user. Owners are not only accounts — trial accounts get a separate
     *    workspace per login, so a key like `visitor:…` arrives.
     */
    version: 6,
    sql: `
ALTER TABLE aas_package ADD COLUMN IF NOT EXISTS owner text;
CREATE INDEX IF NOT EXISTS aas_package_owner_idx ON aas_package (owner);
`,
  },
  {
    /*
     * Version 7 (2026-10-06) — sign-up collects a company name and records the time of consent to personal data collection.
     *
     * Important: NULL is allowed. Neither exists for admin-created accounts or sign-ups on servers without a privacy policy.
     * Important: the consent time is evidence — record when the server received it, not the on-screen checkbox.
     */
    version: 7,
    sql: `
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS consent_at timestamptz;
`,
  },
  {
    /*
     * Version 8 (2026-10-13) — records, for each collected value, **the time this tool actually read it** (the basis for freshness checks).
     *
     * Important: observed_at is the time given by the device (OPC UA SourceTimestamp), so it only moves when the value changes —
     *    tags with a constant value were read fine every time, yet their timestamp froze and they looked "disconnected".
     * Important: NULL is allowed. Old records lack it — it is not invented; the UI falls back to observed_at.
     */
    version: 8,
    sql: `
ALTER TABLE collected_value ADD COLUMN IF NOT EXISTS received_at timestamptz;
`,
  },
  // Version 9 (2026-10-14) — integration tables, see INTEGRATION_SCHEMA_SQL above (CREATE ... IF NOT EXISTS, so idempotent)
  { version: 9, sql: INTEGRATION_SCHEMA_SQL },
];

/**
 * About the collected-value table.
 *
 * Under Option A, collected values only **reference** the model and never write back to it. The one-way
 * reference direction is the core of this DDL — there is no reference in the model → collected-value direction.
 *
 * The location is determined by the AID (interface_name · property_name). The model's idShortPath is not used
 * so that **editing the model does not break collection**. The AID is the contract.
 *
 * When using TimescaleDB, enable the extension and then add the single `HYPERTABLE_SQL` line (not needed on plain PostgreSQL).
 *
 * Important: **always include the casts.** TimescaleDB 2.x has two `create_hypertable` overloads
 * (`regclass, dimension_info` / `regclass, name`); given only quoted strings the type is `unknown`,
 * so it cannot pick one and fails with "function ... does not exist" (measured on 2.29.2).
 * The newer `by_range('observed_at')` only works on 2.13+, so the widely supported legacy signature is used.
 *
 * Important: if you use a dedicated schema, **keep `public` in `search_path`.**
 * TimescaleDB functions live in the schema where the extension is installed (usually public),
 * so `SET search_path TO myschema` alone cannot find `create_hypertable` (measured).
 */
export const HYPERTABLE_SQL =
  "SELECT create_hypertable('collected_value'::regclass, 'observed_at'::name, if_not_exists => TRUE);";
