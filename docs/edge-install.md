# Connecting the remote collector (VEXPLOR Edge) — this server's side

*Korean: [엣지설치.md](엣지설치.md)* · Contract copy: [edge-contract.md](edge-contract.md)

From 2.7.0 the remote collector is **its own open source** — [waceinc/vexplor-edge](https://github.com/waceinc/vexplor-edge)
(Apache-2.0, its own version from 1.0.0). Installing it on the factory PC, layouts (DMZ, equipment network), every
destination it connects to, passwords and certificates, and removal are in that repository's
[install guide](https://github.com/waceinc/vexplor-edge/blob/main/docs/install.md). This page covers only what you do
on the AAS Studio server.

## When to use it

| Where the server is | What reads the machines |
|---|---|
| On the machines' network (a server in the factory) | This server's own collector — "Collect" on the right. No remote collector needed |
| Outside the factory (cloud, head office) | VEXPLOR Edge on one factory PC — reads only an approved list, sends out over HTTPS only |

## One-click connect

1. Open **Settings → Remote collectors (VEXPLOR Edge)**. If it says remote collection is off, an admin presses
   **"Turn on remote collection"** (servers with `EDGE` empty; `EDGE=on` is always on, `EDGE=off` cannot be turned on).
2. **"+ Connect a collector"** — check this server's address as the factory PC reaches it (**https**) and the list it
   will read (machines, tags). With "Approve this list so it reads at once" ticked, the approval is done too. With no
   tags yet, make a collection link (AID) in the machine file first — open the file, then "Create collection link" in
   "Collect" on the right.
3. **"Make the connect command"** — choose the factory PC's tab, **Linux** or **Windows**, and paste the line it shows.
   Both tabs carry the same server and code; the one pasted first uses the code.

   Linux (x64 · arm64), in a terminal:

   ```bash
   curl -fsSL https://github.com/waceinc/vexplor-edge/releases/latest/download/get.sh | sudo sh -s -- --server https://aas.example.com --code 7KQ4-M2XD-9PRT
   ```

   Windows (x64, **VEXPLOR Edge 1.2.0 and later**), in a Command Prompt or PowerShell opened with "Run as administrator":

   ```bat
   powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://github.com/waceinc/vexplor-edge/releases/latest/download/get.ps1))) -Server https://aas.example.com -Code 7KQ4-M2XD-9PRT"
   ```

   It switches on TLS 1.2 for that window, runs `get.ps1` without changing the execution policy, checks the package
   against `SHA256SUMS`, and installs the Windows service `vexplor-edge`. With a proxy entered, the first download goes
   through it as well (`irm -Proxy … -ProxyUseDefaultCredentials`) and `-Proxy` is passed on. The Windows side in full:
   the collector's [install guide — Windows](https://github.com/waceinc/vexplor-edge/blob/main/docs/install.md#windows).

4. Done when the screen shows the PC's name and **"Receiving"**. Values appear by themselves in "Collect" for that
   machine file.

The code in the command works once, for 24 hours. If the list was not approved upfront, press **"Review and approve"**
under "Connected collectors" — nothing is read before that, and a collector waiting for approval asks every 10 seconds,
so it starts right after.

## After connecting

| The screen shows | Meaning |
|---|---|
| Receiving | A batch arrived within 3 minutes |
| Waiting for the first values | Approved, no batch yet |
| Waiting for approval | A person has to approve its read list |
| Silent | Nothing heard for over 3 minutes — check the factory PC's power and its way out to the server (443, proxy) |
| Paused · Revoked | A person stopped it. Paused: "Resume"; revoked: connect again with a new command |

Each device shows the last batch, values received, tags read, machines connected, batches waiting to be sent and the
collector version. When the files change after approval the screen says so, and the collector keeps reading the
approved list until someone approves again.

From 2.8.0 each approved collector also carries the server's **OK · Warning · Problem** badge and its reason in one
line. "Show state" opens the factory PC (CPU, memory, disk, uptime, clock offset, version), the line to the server (last
success, round trip, failures, batches waiting), each piece of equipment (connection, response time, success rate,
reconnects, last lost, last error) and the last 24 hours. These numbers come from **VEXPLOR Edge 1.1.0 or later** — for
1.0.x the screen says "Not sent by this version (1.1.0 or later)" in their place. The limits are in
[usage §8-8](usage.md#8-8-remote-collectors--when-the-server-is-outside-the-factory-one-click). The server's own state
(store, disk, batches of the last hour, version) is in **Settings → Server status** for admins.

## Through the API

The routes the screen uses are in [edge-contract.md](edge-contract.md) section 8 — `GET /edge/status`,
`POST /edge/enable`, `POST /edge/registration-codes` (`approve` to approve in advance), `GET /edge/devices`,
`…/read-list-preview`, `…/approve`, `…/pause`, `…/resume`, `…/revoke`; from 2.8.0 also `…/history` (the last 24
hours) and `GET /server/status` (admins — the server's own state).

## Installing it with a site server

To put AAS Studio and the collector on one factory server, use `sudo ./install.sh --with-edge` from the site bundle
([site-install.md](site-install.md)). The bundle carries the VEXPLOR Edge release package, checked against that
release's `SHA256SUMS`.
