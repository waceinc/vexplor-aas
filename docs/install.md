# Installation guide (for server administrators)

**English** · [한국어](설치.md)

> The manual for people who use the tool is [usage.md](usage.md). This document is for **the person who puts it on a server**.

## Requirements

| Item | Minimum | Recommended |
|---|---|---|
| Operating system | Anything that runs Docker (Linux · Windows · macOS) | Linux server |
| Docker | Docker Engine 20 or later + Compose v2 | Latest |
| Memory | 4 GB | 8 GB |
| Disk | 10 GB | 50 GB (AASX files and collected values accumulate) |
| Internet | **Not needed** — the release package already contains the images | |

## The release package comes in **two builds for different CPUs**

| Package | For | Image inside |
|---|---|---|
| `VEXPLOR-AAS-Studio-<version>-windows.tar.gz` | Windows PCs and servers, Intel/AMD Linux | `linux/amd64` |
| `VEXPLOR-AAS-Studio-<version>-mac.tar.gz` | Apple silicon Macs (M1 or later), ARM Linux | `linux/arm64` |

**Warning:** the wrong build will not start. Give each computer the build that matches its CPU.

## Installing — three steps

Extract the package and **double-click** the installer inside it.
The script file names are in Korean: `설치` = install, `실행` = start, `중지` = stop.

| | Windows | Mac |
|---|---|---|
| 1. Install | `설치.bat` | `설치.command` |
| 2. Start again | `실행.bat` | `실행.command` |
| 3. Stop | `중지.bat` | `중지.command` |

On a Linux server, use a terminal:

```bash
tar xzf VEXPLOR-AAS-Studio-2.8.1-windows.tar.gz
cd VEXPLOR-AAS-Studio-2.8.1-windows
cp .env.example .env      # 1. create the settings file
# open .env and fill in POSTGRES_PASSWORD  <- 2.
docker load -i images.tar.gz && docker compose up -d   # 3.
```

When it is done, open `http://<server-address>:8080`.

## .env — there is **one** value you must fill in

```bash
POSTGRES_PASSWORD=a-long-random-string     # if left empty, it will not start
```

Access control is **optional**. The default is **not locked** —
the typical use of this tool is that anyone inside the company may open and edit.

```bash
AAS_ALLOW_OPEN=1                      # open to the company network without a token (the installer adds this)
AAS_TOKEN=                            # API key for machines. Empty = anyone / set = only holders of that key
AAS_READONLY_TOKEN=                   # read-only key (optional)
AAS_SETUP_CODE=                       # prevents someone else from claiming the first administrator. If empty, a random code is printed in the startup log
AAS_LANG=                             # language of the startup log. en = English, empty = Korean
```

### Use **account sign-in** for people (recommended)

Once it is running, open it in a browser and click **Settings → Create the first administrator**; from then on, people use accounts.
There are three roles — administrator, editor and viewer — and **the change history records who changed what.**
See [usage §12](usage.md) for details.

On a server that is reachable from other computers, creating the first administrator asks for a **setup code**. Find it in the startup log:

```bash
docker compose logs app | grep "setup code"
#   First administrator setup code: 3f9a1c2e7b04
```

The startup log is in Korean unless `AAS_LANG=en` is set in `.env` (operators outside Korea will usually want it); with the Korean log, search for `grep "설치 코드"` instead.

**Warning:** without this code, **anyone on the same network could click first and become administrator**, locking out the person in charge.
To fix the code in advance, put a value in `AAS_SETUP_CODE` in `.env`.

**Warning:** **once people start signing in, put HTTPS in front.** Over plain HTTP, passwords and sign-in
cookies travel as they are. See "Exposing it to the internet" below and usage §12-3.

### Read this only if you want to lock it

Put a value in `AAS_TOKEN` and restart; from then on only people with the token get in.
Use **20 or more** letters, digits and symbols — HTTP headers are meant to be ASCII, so avoid non-ASCII characters.

**Warning:** **if there is no token and no `AAS_ALLOW_OPEN=1`**, the program falls back to a safety mode
and listens on that computer only (`127.0.0.1`). If you started it with Docker, **nobody can connect.**
The installer adds `AAS_ALLOW_OPEN=1` automatically, so you normally do not need to think about this.

The startup log states the current mode in one line — check it once.

| Log line (`AAS_LANG=en`) | Meaning |
|---|---|
| `Opened without a token (AAS_ALLOW_OPEN=1)` | Anyone in the company can use it (installer default) |
| `Authentication on — n full token(s)` | Only token holders |
| `Protected mode` | This computer only — it cannot be opened from elsewhere |
| `First administrator setup code: …` | The value asked for when the first account is created. Not used once an account exists |

### Other settings

| Setting | Meaning |
|---|---|
| `APP_PORT` | Port exposed to the outside (default 8080) |
| `COLLECT` / `COLLECT_INTERVAL` | Collection of field values (OPC UA). `on` plus an interval (seconds) only when you have equipment |
| `COLLECT_RETENTION_DAYS` | **Retention period (days)** for collected values. Older values are deleted at startup and every hour. `.env` default 180 · empty or 0 keeps them forever. Models (AASX) are not touched |
| `COLLECT_COMPRESS_AFTER_DAYS` | TimescaleDB Community Edition only — collected values older than this many days are **compressed** (15 to 22 times smaller, measured — 1 000 tags every second: 1 099 MB an hour raw, 50 MB compressed). Empty = 7 · 0 = no compression |
| `COLLECT_ROLLUPS` | TimescaleDB Community Edition only — **1-minute and 1-hour aggregates** `collected_value_1m` / `collected_value_1h` (avg · min · max · last · count per property), kept up to date and reaching 35 days back so late values from a remote collector are included. Empty = on · `off` = none |
| `COLLECT_ROLLUP_MINUTE_DAYS` | How long the 1-minute aggregate is kept. Empty = 90 · 0 = forever. The 1-hour aggregate is kept |
| `AAS_PUBLIC_URL` | **Required behind a reverse proxy.** The registry advertises this address |
| `CORS_ORIGIN` | When a **web app** at another address (an intranet portal, etc.) calls this API from the browser, list its origins separated by commas. If empty, the browser blocks cross-origin requests (default, safest). The authoring UI is on the same port and does not need it; server-to-server calls are not affected |
| `AAS_POLICY_FILE` | File for changing the conventions (values) without changing code — usage §10-4 |
| `LINT_STANDARD_TERMS` | Choice for rule conflict 5: `kosmo-first` (KOSMO first) or `preserve` (keep the semanticId of standard templates) |
| `AASX_MAX_TOTAL_MB` | Upper limit when unpacking uploaded AASX files. The request body limit follows it (twice this value, at most 512 MB) |
| `OPCUA_SERVER` · `OPCUA_PORT` · `OPCUA_REFRESH` · `OPCUA_HOST` | Serves collected values to upper-level applications (MES, SCADA) over OPC UA. `on` only when needed. Port default 4840 · refresh default 5 seconds · `OPCUA_HOST` is the address of this server advertised to other PCs. Secure by default: clients sign in with a server account and an administrator trusts each client certificate once (see [integration.md](integration.md) chapter 9). `OPCUA_ALLOW_INSECURE=on` restores the old port without authentication — then do not expose it outside the company network. Equipment (PLCs) usually uses 4840 as well; if that could cause confusion, use another port such as 4841 |
| `AAS_WORKSPACE` | Empty: the team sees the same files (default). `private`: each person sees only what they uploaded. Administrators and API keys see everything. Files uploaded before this was turned on appear read-only to everyone. With no accounts and no API keys, file requests are refused until the first administrator is created |
| `AAS_SIGNUP` · `AAS_SIGNUP_ROLE` · `AAS_PRIVACY_URL` | Self sign-up, the role given to new accounts, and the privacy policy address. **Warning:** leave `AAS_SIGNUP` empty on company-network servers — see [deployment.md](deployment.md) §4 |
| `DEMO_MODE` and `AAS_DEMO_*` | Public demo server setup — see [deployment.md](deployment.md) |
| `AAS_LANG` | **Language of the startup log.** `en` = English, empty = Korean. With Docker, set it in `.env` and it is passed through. Only the log the administrator reads changes — each user's screen language is chosen per browser, and if never chosen it follows the browser language (Korean browser → Korean, anything else → English). Text the server produces, such as findings and errors, is returned in the language each request asks for |
| `AAS_TEMPLATES_DIR` | **Templates folder.** `.aasx` files placed here are uploaded at startup (Docker uses `./templates`). Put the official templates from the IDTA Content Hub here and you can pick them directly in "Import from another file". The same file name is not uploaded twice, and a file deleted in the UI comes back at the next startup — to stop using it, remove it from the folder |

## Running without Docker (Node.js)

Instead of the release package, you can run it straight from source. **Node.js 24 LTS is recommended**; **Node.js 22 or later** works
(`engines` in `package.json` requires 22 or later · the Docker image uses Node 24 · CI tests on both Node 22 and 24 · `.nvmrc` says 24).

```bash
npm ci
npm run build && npm run --silent build --workspace @aas/web
node apps/api/dist/server.js      # run from the top folder of the repository
```

Started from the top folder of the repository, it serves the authoring UI from `apps/web/dist` on the same port.
Give the values the Docker setup would otherwise provide yourself.

| Setting | Meaning |
|---|---|
| `PORT` | Listening port (default 8080). Corresponds to `APP_PORT` in Docker |
| `DATABASE_URL` | PostgreSQL connection string — for shared use. If TimescaleDB (Community Edition or Apache-2 Edition) is present it is used for collected values (it also starts without it) |
| `DATABASE_SCHEMA` | Schema name when several instances share one database (optional) |
| `PG_POOL_MAX` | Connections to PostgreSQL the server keeps open at most — a whole number from 1 to 1,000, default 10 (2.8.1). Raise it when many people work at once; keep the total of all servers below the database's `max_connections` (100 by default). Also read from `.env` in the Docker setup |
| `AAS_DATA_DIR` | Folder for keeping files when one person uses it without `DATABASE_URL`. With neither, everything stays **in memory only** and disappears when stopped (the startup log says so) |
| `AAS_HOST` | Sets the address to bind to explicitly. When given, the protected-mode (127.0.0.1) decision above is skipped |
| `WEB_ROOT` | Serve the authoring UI from another folder |
| `SIMULATOR_PORT` | Port of the test OPC UA server started the first time you connect a **Virtual PLC (simulation)** (default 14850) |

Everything else (`AAS_TOKEN` · `AAS_ALLOW_OPEN` · `AAS_LANG` and so on) works as in the tables above.

## Operation

```bash
docker compose logs -f app     # startup log · errors
docker compose ps              # status
docker compose down            # stop (data is kept)
docker compose down -v         # deletes the data too — cannot be undone
docker compose exec db psql -U aas -d aas   # connect to the database directly
```

**Health check**: `curl http://localhost:8080/health` → `{"status":"ok","version":"2.8.1","auth":"on"}`

## Data backup — do it

All AASX files and collected values are in the database. The volume (`pgdata`) survives when containers are removed, but **if the disk dies, the data is gone.**

```bash
# backup
docker compose exec -T db pg_dump -U aas aas | gzip > aas-backup-$(date +%Y%m%d).sql.gz
# restore
gunzip -c aas-backup-20260825.sql.gz | docker compose exec -T db psql -U aas -d aas
```

## Upgrading

**Know this first — the folder name is the name of your data.** Docker finds the data (volume) by the name of the folder
the package was extracted into. If you extract the new version into a folder with a different name and start it as is, **it starts with an empty database**
(the old data is not deleted; it stays under the old name). So write the original name into the `.env` of the new folder.

```bash
# 1. find the name in use — the <name> part of "<name>_pgdata"
docker volume ls | grep pgdata
#   local     vexplor-aas-studio-110-windows_pgdata

# 2. stop the old version
cd VEXPLOR-AAS-Studio-2.8.1-windows && docker compose down && cd ..

# 3. extract the new version and bring the settings over
tar xzf VEXPLOR-AAS-Studio-1.2.0-windows.tar.gz
cd VEXPLOR-AAS-Studio-1.2.0-windows
cp ../VEXPLOR-AAS-Studio-2.8.1-windows/.env .
grep -q '^COMPOSE_PROJECT_NAME=' .env || echo 'COMPOSE_PROJECT_NAME=vexplor-aas-studio-110-windows' >> .env   # the name from step 1

# 4. start it
docker load -i images.tar.gz && docker compose up -d
```

On Windows and Mac, stop the old version with `중지.bat` / `중지.command` in the old folder, copy the old `.env` into the new folder,
add the line `COMPOSE_PROJECT_NAME=<name from step 1>` with Notepad or a text editor, and double-click `설치.bat` / `설치.command`.
Get the same `-windows` / `-mac` build you installed the first time.

This way the old data (volume) is used as it is. After starting, make sure your old files appear on screen. The version number is shown next to the logo at the top left of the screen and in `/health`.

The database tables carry their own **schema version** (the `schema_version` table). When a new program meets an older database,
it upgrades it at startup (log: `Store: postgres · … · schema vN`).
The reverse — **downgrading** (old package + new database) — refuses to start, because stopping is better than an old program
half-reading new tables and losing data. If you must go back, restore the database backup along with it.

## Exposing it to the internet — read this and decide

The default setup is **HTTP**. That is fine inside a company network, but on a public IP:

- **Tokens travel in plain text.** Anyone who intercepts them gets in
- Automated scanners find an open port on a public IP within hours

If you must expose it, put an **HTTPS reverse proxy** (nginx, Caddy, Traefik) in front
and set `AAS_PUBLIC_URL=https://real-address`. If that is hard, a **VPN or tunnel** (Tailscale, etc.)
is safer and simpler to set up.

### Caddy example — the least effort

Caddy obtains and renews certificates by itself. Install Caddy on the server; one `Caddyfile` is enough (template: [../Caddyfile.example](../Caddyfile.example)).

```caddyfile
aas.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
caddy run --config Caddyfile
```

Then set `.env` like this.

```bash
APP_PORT=8080
AAS_PUBLIC_URL=https://aas.example.com   # the address the registry advertises
```

- Without a public domain, use a self-signed certificate with `aas.example.com { tls internal … }`
  and install the Caddy root certificate on the company PCs once
- The program reads the `X-Forwarded-Proto` header added by the proxy and **only over HTTPS**
  adds `Secure` to the sign-in cookie and sends HSTS. If a plain-HTTP server sent HSTS,
  browsers would stick to https for that address for good
- When you use a proxy, bind the port in `docker-compose.yml` to `127.0.0.1:8080:8080`
  so nobody can reach port 8080 directly from outside

**Warning:** **with nginx, pass two headers.** By default `proxy_pass` sends the upstream address,
so `Host` becomes `127.0.0.1:8080`. The program then treats the request as "coming from another site",
and **every save by a signed-in user fails with 403.**

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;              # or X-Forwarded-Host
    proxy_set_header X-Forwarded-Proto $scheme;            # without it the Secure cookie flag is not set
}
```

Caddy passes both by itself, so there is nothing to add.

Known limitations and how to report a vulnerability: [../SECURITY.md](../SECURITY.md).
Running a public demo server: [deployment.md](deployment.md). The list of validation rules: [rules.md](rules.md).

## What to tell us when you ask for help

| | |
|---|---|
| Version | `v2.8.1` at the top left of the screen, or `/health` |
| Startup log | `docker compose logs app | tail -50` |
| Symptom | Which screen, what you clicked, and what appeared |
