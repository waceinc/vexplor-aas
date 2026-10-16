# @aas/edge — VEXPLOR remote collector

The program that runs inside the factory: it reads PLCs and controllers named by an **approved read list** and sends
signed batches out over HTTPS (contract: [`docs/edge-contract.md`](../../docs/edge-contract.md)). One program serves
both AAS Studio and VEXPLOR Logic Studio Cloud.

```bash
vexplor-edge register --config edge.json --code 7KQ4-M2XD-9PRT   # once, with the code a person made on the server
vexplor-edge run --config edge.json                              # what the service runs
```

`edge.json`:

```json
{
  "server": "https://aas.example.com",
  "stateDir": "/var/lib/vexplor-edge",
  "proxy": "http://proxy.plant.local:3128",
  "credentialsFile": "credentials.json",
  "opcua": { "trustFirstUse": false }
}
```

- **Read only, outbound only.** It never writes to a device, listens on no port and has no remote stop. A revoked
  device stops sending by itself and keeps its queue.
- **Nothing lost on an outage.** Batches wait on disk (`stateDir/queue`) and go out in order with the same boot id and
  sequence when the server answers again; the server stores each once. One batch is in flight at a time, so a backlog
  always arrives before newer batches. A batch waits at most `maxQueueDays` (default 30) — older ones, like those past
  `maxQueuedBatches`, are dropped and counted in `status.droppedBatches`.
- **Secrets stay here.** The private key is made on this machine; PLC passwords live in `credentialsFile` by endpoint,
  never in the AAS or the read list.
- **Batches stay few during an outage.** One batch every `flushIntervalMs` (default 5 s — 12 requests a minute, well
  under the server's 60) while sending works; while it is paused, at most one a minute or when a batch is full, so a long
  outage leaves a backlog the server takes in minutes.
- **A stop loses nothing either.** Samples read but not yet batched go to the queue on SIGINT/SIGTERM and are sent by
  the next start.
- **Update notices, never installs.** With `"update": { "manifestUrl": "https://…/latest.json", "publicKey": "<release
  key>" }` it checks once a day and reports a newer release signed by that key (log and the next batch's status). It
  downloads and installs nothing — a person installs it with the installer. Without the setting it makes no update
  request at all. A soak of a real 30-minute outage: `EDGE_SOAK_MINUTES=30 npx vitest run packages/edge/test/soak.test.ts`.
- **Changes only (OPC UA)**: `"opcua": { "mode": "subscribe", "deadband": 0, "resendMs": 300000 }` — the PLC reports
  changes, the deadband skips small changes of analog tags (never counters), an unchanged value is sent again every
  `resendMs`. Default `"poll"`.
- OPC UA security (mode, policy, user name) comes from the AID through the read list; the OPC UA certificate store is
  `stateDir/opcua-pki` (an unknown server certificate waits in `rejected/` unless `trustFirstUse`).

Tests (`packages/edge/test/agent.test.ts`) run it against a real AAS Studio and a real OPC UA server: every sample
stored once, recovery after the server was gone, a CONNECT proxy with TLS end to end, STD-009 T9 (no connection but the
proxy and the PLC) and T10 (no listening port, command, remote stop or built-in account in the code).
