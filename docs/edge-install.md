# Installing the remote collector (VEXPLOR Edge)

*Korean: [엣지설치.md](엣지설치.md)* · Contract: [edge-contract.md](edge-contract.md)

VEXPLOR Edge is one program on one PC in the factory. It reads PLCs and controllers named by a **read list a person
approved on the server**, and sends signed batches out over HTTPS. It is read only, opens no port, and has no remote
stop. The same program works with AAS Studio and with VEXPLOR Logic Studio Cloud.

## 1. Where to put it — two layouts

| | A. DMZ / office network | B. Equipment network |
|---|---|---|
| The PC sits | Between the office and equipment networks, reaching both | On the equipment network, with an outbound route to the server (often through a proxy) |
| Firewall towards the equipment | The PC → PLC ports (OPC UA 4840, Modbus 502, MQTT 1883/8883) | Nothing new |
| Firewall towards the outside | The PC → the server on 443 (or the proxy) | The PC → the proxy (or the server on 443) |
| Inbound to the PC | **None** | **None** |

Choose A when the equipment network has no route out at all; choose B when one PC on the equipment network may go out
through the site proxy. In both, nothing connects in.

## 2. What it connects to (the complete list)

| Destination | Why | When |
|---|---|---|
| The server address in the configuration, port 443 (or through `proxy`) | Read list, batches, registration | Always |
| The PLC endpoints in the approved read list (OPC UA, Modbus TCP, MQTT) | Reading values | After approval |
| `update.manifestUrl` | Release notice, once a day | Only if configured |

There is nothing else. The tests check this (STD-009 T9) by recording every connection attempt.

## 3. Install

Download `vexplor-edge-<version>-linux-x64.tar.gz` or `-win-x64.zip` and check it against `SHA256SUMS` from the same
release:

```bash
sha256sum -c SHA256SUMS --ignore-missing            # Linux
Get-FileHash .\vexplor-edge-<version>-win-x64.zip   # Windows — compare with SHA256SUMS
```

On the server, a person makes a **registration code** (`POST /edge/registration-codes`, valid 24 h, one use).

**Linux** (systemd):

```bash
tar xzf vexplor-edge-<version>-linux-x64.tar.gz && cd vexplor-edge-<version>
sudo ./install.sh --server https://aas.example.com --code 7KQ4-M2XD-9PRT [--proxy http://proxy:3128] [--ca-file corp-ca.pem]
```

Program in `/opt/vexplor-edge`, configuration in `/etc/vexplor-edge/edge.json`, key and queue in
`/var/lib/vexplor-edge` (service account only). The service `vexplor-edge` runs hardened (no new privileges, read-only
system, its state folder writable, no capabilities). Logs: `journalctl -u vexplor-edge`.

**Windows** (an elevated PowerShell; the service is run by WinSW):

```powershell
Expand-Archive vexplor-edge-<version>-win-x64.zip; cd vexplor-edge-<version>-win-x64\vexplor-edge-<version>
.\install.ps1 -Server https://aas.example.com -Code 7KQ4-M2XD-9PRT [-Proxy http://proxy:3128] [-CaFile corp-ca.pem]
```

Program in `C:\Program Files\VEXPLOR Edge`, configuration, key and queue in `C:\ProgramData\VEXPLOR Edge` (SYSTEM,
Administrators and the service account only). The executable is not code-signed yet — verify it with `SHA256SUMS`.

Then **approve** the device on the server (`GET /edge/devices/:id/read-list-preview`, then `POST …/approve` with that
revision). It reads nothing before.

## 4. Passwords and certificates

- **PLC passwords** live in a credentials file on this PC, by endpoint — `{ "opc.tcp://10.0.0.5:4840": { "userName",
  "password" } }` — passed with `--credentials-file` / `-CredentialsFile`. They are never in the AAS or the read list.
- **OPC UA certificates**: the collector makes its own certificate in `<state>/opcua-pki`. A server certificate it has
  never seen is refused and kept in `<state>/opcua-pki/rejected`; move it to `trusted/certs` to trust it, or set
  `"opcua": { "trustFirstUse": true }`. The OPC UA server must trust the collector's certificate too.

## 5. Running it

- An outage loses nothing: batches wait in `<state>/queue` and go out in order when the server answers again (each is
  stored once). Past `maxQueuedBatches` (default 100 000), or older than `maxQueueDays` (default 30), the oldest are
  dropped and reported, never silently.
- A batch the server refuses as malformed goes to `<state>/refused` for a person to look at.
- A revoked device stops sending by itself and keeps its queue; it never registers again on its own.
- Update notices (optional): with `"update": { "manifestUrl": "https://…", "publicKey": "<release key>" }` it reports a
  newer signed release in the log and the next batch's status. It downloads and installs nothing — install the new
  package with the same installer.

## 6. Remove

Linux: `sudo systemctl disable --now vexplor-edge && sudo rm -r /opt/vexplor-edge /etc/vexplor-edge /etc/systemd/system/vexplor-edge.service`
(and `/var/lib/vexplor-edge` once its queue is no longer needed). Windows: `vexplor-edge-service.exe stop`,
`vexplor-edge-service.exe uninstall`, then remove the two folders. Revoke the device on the server as well.

## 7. What was checked

The Linux package was installed with this guide on a fresh Ubuntu 24.04 (x86_64) and registered, approved and sent
values from an OPC UA server over the network. The Windows package is built the same way but has **not yet been
installed on a Windows PC**.
