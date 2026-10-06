/**
 * PostgreSQL 스키마 (기획서 M1 · 값 동기화 A안).
 *
 * DDL을 파일이 아니라 문자열로 두는 이유는 배포 형태(도커 이미지·번들·서버리스)에 따라
 * 파일 경로가 흔들리기 때문이다. 운영 DBA에게 넘길 때는 이 상수를 그대로 덤프하면 된다.
 *
 * 설계 근거는 docs/PROGRESS.md §2-2. 요약하면
 *  ① content(jsonb)가 원본이고 나머지 컬럼은 파생이다. 어긋나면 원본이 이긴다.
 *  ② ordinal이 없으면 무손실 export가 성립하지 않는다.
 *  ③ id에 UNIQUE를 걸지 않는다 — 결함 파일도 손실 없이 받아야 린터가 지적할 수 있다.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS aas_package (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  spec_part   text NOT NULL DEFAULT '/aasx/data.json',
  revision    integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 주인(작업 공간 열쇠). NULL = 공용. 팀이 같이 쓰는 서버에서는 전부 NULL이다
  owner       text
);
-- 🔴 owner의 색인은 **여기 두지 않는다**(MIGRATIONS 6판에 있다). 판 번호를 쓰기 전의 옛 DB는
--    이 문장들이 마이그레이션보다 먼저 도는데, 표는 이미 있어 건너뛰고 색인만 만들려다
--    「그런 열이 없다」로 기동이 터진다. 새 열을 가리키는 색인은 열을 더하는 자리에 함께 둔다.

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
  -- 연락처(선택). 🔴 확인하지 않는다 — 메일 서버가 없고, 흉내만 내면 더 나쁘다.
  --    UNIQUE도 걸지 않는다: 한 사람이 계정을 둘 가질 수 있고, 막을 이유가 없다
  email         text,
  -- 회사명 · 개인정보 수집 동의 시각(7판). 처리방침을 올린 서버의 가입에서만 채워진다
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
  -- 🔴 app_user를 참조하지 **않는다.** 계정을 지워도 감사 기록은 남아야 하고,
  --    이름도 그때의 것을 베껴 둔다(사람 이름이 바뀌어도 과거 기록은 안 바뀐다)
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
  quality        text
);

CREATE INDEX IF NOT EXISTS collected_value_idx ON collected_value (package_id, property_name, observed_at DESC);
`;

/**
 * 스키마 판 번호.
 *
 * 표가 어느 판인지 DB 자체에 적어 둔다. 판올림한 프로그램이 옛 DB를 만나면 `MIGRATIONS`를
 * 차례로 적용하고, 반대로 **DB가 프로그램보다 새로우면 기동을 거부한다** — 옛 코드가 새 표를
 * 반쯤 읽고 조용히 잃는 것이 가장 나쁜 사고다(basyx가 그랬다).
 *
 * 규약:
 *  - `SCHEMA_SQL`은 항상 **최신 판의 완성형**이고 멱등(IF NOT EXISTS)이다. 빈 DB는 이것 하나로 최신이 된다.
 *  - 판을 올릴 때는 ① SCHEMA_SQL을 고치고 ② 같은 변경을 `MIGRATIONS`에 ALTER로 한 칸 더한다
 *    ③ `SCHEMA_VERSION`을 올린다. 마이그레이션은 앞 판의 표를 새 판으로 만들어야 하며 멱등이어야 한다.
 *  - `schema_version`이 없는 기존 DB는 1판으로 본다(판 번호를 도입한 2026-09-04 시점의 표가 1판이다).
 */
export const SCHEMA_VERSION = 7;

export const SCHEMA_VERSION_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

/**
 * 판 n-1 → n 으로 올리는 문장들. 판 1은 기준(baseline)이라 항목이 없다.
 * 🔴 **멱등이어야 한다** — 판 번호 도입 전의 DB(0)에도 차례로 다시 돌린다.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    // 2판 (2026-09-30) — 레퍼런스 번들 첨부(role 'bundle'). 열 제약의 자동 이름은 <표>_<열>_check
    version: 2,
    sql: `
ALTER TABLE aas_package_file DROP CONSTRAINT IF EXISTS aas_package_file_role_check;
ALTER TABLE aas_package_file ADD CONSTRAINT aas_package_file_role_check
  CHECK (role IN ('thumbnail', 'supplementary', 'extra', 'bundle'));
`,
  },
  {
    /*
     * 3판 (2026-10-02) — 사용자 계정. 토큰 하나를 돌려 쓰던 것을 사람 단위로 바꾼다.
     *
     * 🔴 **세션 표는 두지 않는다.** 저장소 구현이 셋(memory·folder·postgres)이라 세션까지
     *    영속시키면 셋 다 손봐야 하는데, 이 도구는 서버 한 대가 전제다. 세션은 그 서버의
     *    메모리에 둔다 — 서버를 내리면 다시 로그인한다. 폐쇄망에서 치를 만한 값이다.
     * 🔴 비밀번호는 **해시만** 둔다(scrypt, Node 내장). 원문은 어디에도 남기지 않는다.
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
  -- 연락처(선택). 🔴 확인하지 않는다 — 메일 서버가 없고, 흉내만 내면 더 나쁘다.
  --    UNIQUE도 걸지 않는다: 한 사람이 계정을 둘 가질 수 있고, 막을 이유가 없다
  email         text
);
`,
  },
  {
    /*
     * 4판 (2026-10-02) — 감사 기록의 「누가」. 이력에 바꾼 사람을 적는다.
     *
     * 🔴 **NULL을 허용한다.** 이 판 이전에 쌓인 이력에는 바꾼 사람이 없다. 그것을
     *    「알 수 없음」이 아닌 아무 값으로 채우면 없던 사실을 지어내는 것이다.
     * 🔴 외래키를 걸지 않는다 — 계정을 지웠다고 감사 기록이 함께 사라지면 안 된다.
     */
    version: 4,
    sql: `
ALTER TABLE identifiable_history ADD COLUMN IF NOT EXISTS actor_id   text;
ALTER TABLE identifiable_history ADD COLUMN IF NOT EXISTS actor_name text;
`,
  },
  {
    /*
     * 5판 (2026-10-04) — 회원가입. 연락처를 **선택**으로 받는다.
     *
     * 🔴 NULL을 허용한다. 사내망에서 관리자가 만들어 주는 계정에는 연락처가 없고,
     *    없는 것을 빈 문자열로 채우면 「안 적었다」와 「빈 값」이 섞인다.
     * 🔴 개인정보다 — 받기 시작하면 처리방침·동의·보관기간·파기가 따라온다.
     *    그래서 **안 받아도 돌아가게** 두었다(docs/배포_호스팅.md).
     */
    version: 5,
    sql: `
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email text;
`,
  },
  {
    /*
     * 6판 (2026-10-04) — 작업 공간. 패키지에 주인을 적는다.
     *
     * 🔴 **NULL이 「공용」이다.** 이 판 이전의 패키지는 전부 NULL이 되고, 그래서 옛 DB를
     *    올려도 **아무 것도 달라지지 않는다** — 모두가 전부를 보던 그대로다.
     *    주인을 지어내 채우면 멀쩡히 같이 쓰던 파일이 한 사람 것이 되어 버린다.
     * 🔴 app_user를 참조하지 않는다. 주인은 계정만이 아니다 — 체험 계정은 로그인마다
     *    작업 공간이 따로라 `visitor:…` 같은 열쇠가 온다.
     */
    version: 6,
    sql: `
ALTER TABLE aas_package ADD COLUMN IF NOT EXISTS owner text;
CREATE INDEX IF NOT EXISTS aas_package_owner_idx ON aas_package (owner);
`,
  },
  {
    /*
     * 7판 (2026-10-06) — 회원가입에서 회사명을 받고, 개인정보 수집 동의 시각을 적는다.
     *
     * 🔴 NULL을 허용한다. 관리자가 만든 계정·처리방침 없는 서버의 가입에는 둘 다 없다.
     * 🔴 동의 시각은 증빙이다 — 화면의 체크가 아니라 서버가 받은 때를 적는다.
     */
    version: 7,
    sql: `
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS consent_at timestamptz;
`,
  },
];

/**
 * 수집값 테이블에 대하여.
 *
 * A안에서 수집값은 모델을 **참조만** 하고 절대 되쓰지 않는다. 참조 방향이 단방향이라는 점이
 * 이 DDL의 핵심이다 — 모델 → 수집값 방향의 참조는 없다.
 *
 * 위치는 AID가 정한다(interface_name · property_name). 모델의 idShortPath를 쓰지 않는 이유는
 * **모델을 편집해도 수집이 끊기지 않게** 하기 위해서다. AID가 곧 계약이다.
 *
 * TimescaleDB를 쓸 때는 확장을 켠 뒤 `HYPERTABLE_SQL` 한 줄을 더한다(일반 PostgreSQL에서는 필요 없다).
 *
 * 🔴 **캐스팅을 반드시 붙인다.** TimescaleDB 2.x에는 `create_hypertable` 과부하가 둘 있어
 * (`regclass, dimension_info` / `regclass, name`), 따옴표 문자열만 주면 `unknown`이라
 * 어느 쪽인지 못 정하고 "function ... does not exist"로 실패한다(2.29.2 실측).
 * 신형 `by_range('observed_at')`는 2.13 이상에서만 되므로, 넓게 도는 구형 시그니처를 쓴다.
 *
 * 🔴 전용 스키마를 쓴다면 **`search_path`에 `public`을 남겨야 한다.**
 * TimescaleDB 함수는 확장이 설치된 스키마(보통 public)에 있어서,
 * `SET search_path TO myschema`만 하면 `create_hypertable`을 찾지 못한다(실측).
 */
export const HYPERTABLE_SQL =
  "SELECT create_hypertable('collected_value'::regclass, 'observed_at'::name, if_not_exists => TRUE);";
