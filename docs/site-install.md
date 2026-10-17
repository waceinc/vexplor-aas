# Site server install — AAS Studio + TimescaleDB + remote collector (Linux)

*Korean: [현장설치.md](현장설치.md)* · Collector: [edge-install.md](edge-install.md) · All settings: [install.md](install.md)

One command puts AAS Studio and a time-series database (TimescaleDB) on one factory server, optionally with the remote
collector (VEXPLOR Edge) on the same machine. The bundle carries the program images, so it installs without internet.
Equipment values stay in the factory, and old values are compressed.

This guide covers **Linux** (x86_64, systemd). **Windows servers will be covered later.**

## 1. Two bundles

| | Default bundle `VEXPLOR-AAS-Studio-<version>-linux` | Community bundle `…-linux-community` |
|---|---|---|
| Database | **TimescaleDB Apache-2 Edition** (Apache 2.0) | **TimescaleDB Community Edition** (Timescale License) |
| For | Every install, free ones included | Customers with a paid licence agreement carrying the third-party-software clause |
| Compression of collected values | No | Yes — 15 to 22 times smaller, measured |
| 1-minute and 1-hour aggregates | No | Yes (`collected_value_1m` · `collected_value_1h`) |
| Retention (old values removed) | Yes | Yes |

Both pin one TimescaleDB version (now 2.30.2). Each bundle holds `THIRD-PARTY-NOTICES.txt`, the licence texts under
`licenses/` and `BUNDLE.txt` (what went in, with image digests); the bundle hashes are in the release's `SHA256SUMS`.

**With the Community bundle** the customer, under the Timescale License, does not create or change the schema of the
database AAS Studio uses (tables, columns, indexes and the like — reading is fine), and does not use it as a database
product or service outside AAS Studio. See the notice on the first page of the bundle and `licenses/TimescaleDB-TSL.txt`.

## 2. What you need

- A Linux server (x86_64, systemd) with Docker Engine and the Compose plugin — Ubuntu: `sudo apt install docker.io
  docker-compose-v2`. On a server without internet, install those packages from media first.
- Size: **checked minimum** 2 vCPU · 4 GB memory · 40 GB disk — install, reboot and collection were checked on a virtual
  server of that size; idle, AAS Studio and the database together use about 0.2 GB. A factory reading **1 000 tags every
  second**: 4 vCPU · 8 GB or more and an SSD are recommended (an estimate); the disk comes from section 3.

## 3. Disk

Rows a day = tags × 86 400 ÷ read interval in seconds. Size of one row (measured on TimescaleDB 2.30.2, 1 000 tags every
second for an hour = 3.6 million rows):

| | One row | Note |
|---|---|---|
| Raw (before compression) | about 320 bytes | indexes included |
| Compressed | about 15 bytes | Community bundle only |
| 1-minute aggregate | about 170 bytes per tag and minute | Community bundle only, kept 90 days by default |
| 1-hour aggregate | about 230 bytes per tag and hour | Community bundle only, kept |

Disk needed (values kept 180 days, 1-hour aggregate 3 years, 30 % headroom):

| Factory | Raw a day | Community — compressed after 7 days | Community — after 1 day | Default bundle (no compression) |
|---|---|---|---|---|
| 100 tags · 1 s | 2.6 GB | about 53 GB | about 34 GB | about 600 GB |
| 1 000 tags · 5 s | 5.1 GB | about 134 GB | about 95 GB | about 1.2 TB |
| 1 000 tags · 1 s | 25.7 GB | about 532 GB | about 341 GB | about 6 TB |

The measurement used synthetic values (a sine with noise); real equipment, whose values often repeat, compresses
further. Without compression (default bundle) fit the disk by a shorter `COLLECT_RETENTION_DAYS` or a longer interval.

## 4. Install

```bash
tar xzf VEXPLOR-AAS-Studio-<version>-linux.tar.gz          # Community customers: …-linux-community.tar.gz
cd VEXPLOR-AAS-Studio-<version>-linux
sudo ./install.sh                                          # AAS Studio + database
sudo ./install.sh --with-edge --edge-name "Line 1"         # + the remote collector on the same server
```

It checks Docker and enables it at boot, puts the program in `/opt/vexplor-aas`, writes `.env` (root only) with a new
database administrator password, an app account, a secret key and a first-admin code, loads the images, starts them and
waits until the server answers. With `--with-edge` it registers the collector to this AAS Studio and starts it as a
service. Other options: `--port 8080`, `--dir /opt/vexplor-aas`, `--edge-credentials <file>` (PLC passwords,
[the collector's install guide](https://github.com/waceinc/vexplor-edge/blob/main/docs/install.md) §4).

It ends with the address and the first-admin code. The collector reads nothing until **a person approves** its read list
on the server.

## 5. Security defaults

- **The database port is not published.** Only AAS Studio connects, inside the server.
- **The app connects with its own account (`aas_app`), not an administrator**; that account owns its tables. The database
  administrator password is only in `.env`, never shown on screen or in this guide.
- **Screen and API actions do not change the schema.** It changes only when the server starts and in its scheduled
  retention job.

## 6. Running it

| Task | Command |
|---|---|
| Status | `cd /opt/vexplor-aas && sudo docker compose ps` |
| Log | `sudo docker compose logs -f app` — the "store" line shows the database edition and whether compression and aggregates are on |
| Stop · start | `sudo docker compose down` (data stays) · `sudo docker compose up -d` |
| Upgrade | Unpack the new bundle and run the same `sudo ./install.sh` — `.env` and data stay |
| Backup | `sudo docker compose exec -T db pg_dump -U postgres -Fc aas > aas-$(date +%F).dump` |
| Collector | `systemctl status vexplor-edge` · `journalctl -u vexplor-edge` |

After a reboot Docker, AAS Studio, the database and the collector all come back by themselves. Retention, compression and
aggregates are set in `/opt/vexplor-aas/.env` (`COLLECT_RETENTION_DAYS` default 180, `COLLECT_COMPRESS_AFTER_DAYS`
default 7, `COLLECT_ROLLUPS`, `COLLECT_ROLLUP_MINUTE_DAYS` default 90 — meanings in [install.md](install.md)) and take effect
with `sudo docker compose up -d`.

## 7. Remove

```bash
cd /opt/vexplor-aas && sudo docker compose down -v      # -v deletes the data too (irreversible)
sudo systemctl disable --now vexplor-edge                # if the collector was installed — the rest in the collector's install guide §6
```

## 8. What was checked

On a fresh Ubuntu 24.04 virtual server (2 vCPU · 4 GB) with only Docker added, following this guide: one
`sudo ./install.sh --with-edge` installed everything and registered the collector in about 20 seconds; after a reboot
everything came back by itself; after approval, values from a PLC simulator across the network were stored; the app
connects with a non-administrator account and the database port is not published. Both bundles were checked; with the
Community bundle the compression, aggregate and retention jobs ran as the app account. The test used ARM bundles; the
x86_64 bundles are made by the same script.
