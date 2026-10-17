# Edge contract — `vexplor.edge/1`

*Korean: [엣지계약.md](엣지계약.md)* · Canonical: [waceinc/vexplor-edge `docs/contract.md`](https://github.com/waceinc/vexplor-edge/blob/main/docs/contract.md) — this is the copy the AAS Studio server follows (schemas, examples and the signing example must equal the canonical ones; the collector repository's tests compare them)

One small program runs inside the factory — the **remote collector** (the "edge"). It reads PLCs and controllers and
sends the values out. This contract is what it talks to. **Two products implement the same server side** — VEXPLOR AAS
Studio and VEXPLOR Logic Studio Cloud — so one edge program serves both.

| | |
|---|---|
| Contract | `vexplor.edge/1` |
| Endpoints | `POST /edge/v1/register` (once) · `GET /edge/v1/read-list` · `POST /edge/v1/batches` |
| Schemas | [`docs/edge/schemas/`](edge/schemas/) — JSON Schema; worked examples in [`docs/edge/examples/`](edge/examples/) |
| Transport | HTTPS, JSON bodies, UTF-8. The edge connects out; nothing connects in to the factory |
| Identity | One-time registration code → the edge makes an Ed25519 key pair and registers the public key → every request is signed |
| Idempotency | (device, `bootId`, `seq`) — a batch sent twice is stored once |

## 1. Principles

1. **Outbound only.** The edge opens HTTPS connections to the server (port 443, optionally through an HTTP `CONNECT`
   proxy). The server never connects to the edge or into the factory network.
2. **Read only.** The edge reads equipment. It never writes to a PLC. The contract has no command channel and **no
   remote stop** — the server can only (a) change the read list, which takes effect after a person approves it, and
   (b) revoke the device, after which the edge stops sending.
3. **No AAS parser on the edge.** The server reads the AAS (AID — Asset Interfaces Description) and hands the edge a
   plain list of what to read and where. The edge knows protocols, not the AAS metamodel.
4. **Nothing is read before a person approves.** A new device, or a changed list, gets an empty list until someone
   approves the tags on the server.
5. **Values are not written into the AAS.** The server keeps them in its value store; the AAS keeps the interface
   description and references only.
6. **Add only.** Within `/1`, fields are only ever added. Both sides ignore fields they do not know. Anything else is a
   new contract (`vexplor.edge/2`, new paths `/edge/v2/…`), and the server keeps `/1` for at least one release.

## 2. Signing every request

Every request carries four headers:

| Header | Value |
|---|---|
| `X-Edge-Device` | The `deviceId` from registration. On `register` itself: the literal `register` |
| `X-Edge-Timestamp` | Unix time in seconds. The server accepts ±300 s from its clock |
| `X-Edge-Nonce` | 16 or more random bytes, base64url. Not reused by the device within 10 minutes |
| `X-Edge-Signature` | `ed25519=` + base64url (no padding) of the 64-byte signature |

The signed text is seven lines joined by `\n` (no trailing newline), UTF-8:

```
vexplor.edge/1
<METHOD, upper case>
<path and query exactly as sent, e.g. /edge/v1/read-list>
<X-Edge-Timestamp>
<X-Edge-Nonce>
<X-Edge-Device>
<lower-case hex SHA-256 of the body bytes — of the empty string for GET>
```

The first line is the contract name. Signing the body hash and the path — not the TLS session — lets the
signature survive TLS-inspecting proxies. The register request is signed with the key it registers (proof that the edge
holds the private key).

**Worked example** (RFC 8032 §7.1 test key 1 — never use it for a real device):

| | |
|---|---|
| Private key seed (hex) | `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60` |
| Public key (base64url) | `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo` |
| Request | `POST /edge/v1/batches`, device `dev_8Q2K7M4N`, timestamp `1792141205`, nonce `bm9uY2UtMDAwMDAwMDAwMQ` |
| Body | [`docs/edge/examples/signed-batch.body.json`](edge/examples/signed-batch.body.json) (exact bytes, no trailing newline) |
| Body SHA-256 | `c0d5d9913f729fa8d4893e7f6c30fd2e665d42559f84642514365e0955427651` |
| `X-Edge-Signature` | `ed25519=vEOC6NvXN1SGvT7EJPnqD1O4ji89dr-Uk1UVaUqO94fX5-RVDpwhEwnAW2dVXAkRSztL_kHUP7LgTvQL1LwiCA` |

## 3. Register — `POST /edge/v1/register`

A person creates a **registration code** on the server (it belongs to one workspace, works once, and expires — 24 hours
unless the server says otherwise). The edge is installed with that code, makes its own Ed25519 key pair, keeps the
private key on the machine, and sends:

Request `vexplor.edge.register/1` — `code`, `publicKey` (32 raw bytes, base64url), `device` (`name`, optional
`hostname`, `software` `{name, version}`). Response **201** `vexplor.edge.registration/1` — `deviceId`, `registeredAt`,
`server` (`tool`, `version`, `contract`), `limits`, `readList` (`path`, `pollSeconds`).

The device belongs to the code's workspace and sees nothing else. A code that is unknown, used or expired answers 401
`RegistrationCodeInvalid` — the server does not say which. The same public key cannot be registered twice (409
`KeyAlreadyRegistered`).

## 4. Read list — `GET /edge/v1/read-list`

What to read, already resolved from the AAS by the server. Response **200** `vexplor.edge.readList/1`:

- `revision` — opaque string; changes whenever the list changes. Send it back as `If-None-Match: "<revision>"` to get
  **304** when nothing changed. The response carries it as `ETag` too.
- `state` — `pending-approval` (nothing approved yet: `interfaces` is empty), `approved`, or `paused` (approved before,
  stopped by a person: `interfaces` is empty, the edge stops reading).
- `pollSeconds` — how long to wait before asking again (the edge may ask sooner after a 2xx batch answer reports a
  different `readListRevision`). A server may give a shorter value while the device waits for approval (AAS Studio gives
  10 s — an approval reaches the device within seconds).
- `interfaces[]` — one per equipment connection: `interfaceId`, `packageId`, `aasId`, `globalAssetId`,
  `interfaceName` (the AID interface), `protocol` (`OPCUA` · `MODBUS` · `MQTT` · `HTTP`), `endpoint` (AID `base`),
  `security`, `intervalMs`, and `tags[]` — `tagId`, `propertyName`, `address` (AID `href`), optional `key`, `type`,
  `unit`, `fields` (the remaining AID form fields, as text, by name), and optional `intervalMs` that overrides the
  interface's for that tag.
- `security` — `mode` (`None` · `Sign` · `SignAndEncrypt` for OPC UA; `None` · `TLS` otherwise), optional `policy`, and
  optional `credentialRef`. **The list never carries a password or a key.** `credentialRef` names a credential the
  installer stored on the edge machine; the edge looks it up locally.

An interface whose protocol the edge does not support is skipped and reported in the next batch's `status`.

### 4.1 Tag hints (added in 2.5.0 — optional, advisory)

Each tag may carry three hints for a receiver that shows the list to a person before approval (another product
building its own read list with `aidReadList` from `@aas/bundle` gets the same):

- `semanticId` — the semanticId of the model element the tag's value belongs to (found by the same rule as the live
  overlay and runtime events). Absent when the property resolves to no element, or to more than one.
- `suggestedRole` — `run_state` · `counter` · `alarm_source` · `meter` · `condition` · `quality` · `value`, from a
  table of semanticIds (`apps/api/src/edge/tag-hints.ts`, exact match). Unknown semanticIds suggest `value`.
- `limits[]` — `{ bound: "usl" | "lsl", value, semanticId, source }` from properties of the same file that bound this
  value (e.g. TechnicalData `MaxSettingForce` for `SettingForce`). A value may have several (a performance limit and a
  safety limit); all are listed with their `source` (`<submodel idShort>:<idShortPath>`).

Hints are **not part of `revision`**: a server update that adds or changes hints never asks a site to approve again,
and an edge never restarts for one. An edge ignores them. A person confirms every role and limit — a hint decides
nothing on its own.

## 5. Batches — `POST /edge/v1/batches`

Request `vexplor.edge.batch/1`:

- `bootId` — a UUID made fresh every time the edge process starts.
- `seq` — integer from 1, +1 for every new batch within the boot. **(device, `bootId`, `seq`) is the idempotency key.**
- `readListRevision` — the list the values were read with.
- `createdAt`, `samples[]` — `tagId`, `observedAt` (device time when known, else read time), `receivedAt` (when the
  edge read it), `value` (number, string, boolean or null), optional `quality` and `error`.
- optional `status` — `startedAt`, `queuedBatches`, `droppedBatches`, `software`, and per interface `connected` and
  `lastError`. A batch with no samples is a valid heartbeat.

Response **200** `vexplor.edge.batchResult/1` — `bootId`, `seq`, `accepted`, `duplicate`, `rejected[]` (`index`,
`tagId`, `code` — e.g. a tag that is not in the approved list), and the server's current `readListRevision`.

`rejected[].code` says why one sample was not stored: `NotApproved` (nothing approved yet), `UnknownTag` (not in the
approved list), `PackageUnavailable` (the file is gone or no longer the device's), `BadTime`, `TooLong`, `TypeMismatch`
(e.g. text for a `float` tag). The other samples of the batch are stored; a refused sample is not sent again.

A batch the server already has answers 200 with `duplicate: true` and stores nothing again. The server does not require
`seq` to arrive in order or without gaps.

**Order.** The edge sends one batch at a time, oldest first, and starts the next only after the previous one was
answered — a backlog after an outage arrives before the batches read after it. A receiver may therefore treat a batch
older than the last it stored from the same device as a backlog, not as a clock fault.

## 6. Limits, errors and what the edge does

Limits come with the registration (`limits`) and may be lowered at any time — the server then answers 413 or 429.
Defaults: `maxBatchBytes` 1 048 576, `maxSamplesPerBatch` 5 000, `requestsPerMinute` 60, per device.

Errors use one envelope, `vexplor.edge.error/1` — `code`, `message`, `retryable`, optional `retryAfterSeconds`.

| Status | `code` | The edge |
|---|---|---|
| 400 / 422 | `BadRequest` · `SchemaMismatch` | Keeps the batch in a local "refused" folder, does not resend, continues with the next |
| 401 | `SignatureInvalid` · `UnknownDevice` | Stops sending, keeps the queue, raises a local alarm. Never re-registers by itself |
| 401 | `ClockSkew` | Retries after checking the clock (logs the server `Date` header) |
| 401 | `RegistrationCodeInvalid` | Register only — asks the installer for a new code |
| 403 | `DeviceRevoked` | Stops sending, keeps the queue, raises a local alarm |
| 409 | `KeyAlreadyRegistered` | Register only — makes a new key pair and asks for a new code |
| 413 | `PayloadTooLarge` | Splits the samples into new batches (new `seq`), keeps the original in "refused" |
| 429 · 503 | `RateLimited` · `Unavailable` | Waits `Retry-After` (seconds), resends the **same** batch |
| 5xx · network · timeout | `ServerError` | Resends the **same** batch with backoff: 1 s doubling to 5 min, ±20 % jitter |
| Any other status (404, 405 …) | — | As 5xx: resends the same batch with backoff and logs it. Only 401 (not `ClockSkew`) and 403 stop the edge — another answer comes from something between (a proxy, an upgrade) |

**Local queue.** Every batch is written to disk before it is sent and deleted only after a 2xx. When the queue reaches
its configured size, the oldest batches are dropped and counted in `status.droppedBatches` — never silently.

**How long a batch may wait.** An unsent batch is kept at most `maxQueueDays` (default 30 days, an edge setting); older
ones are dropped and counted the same way. A receiver keeps its duplicate memory (the idempotency key of §5) **longer
than that**, so a batch resent at the end of an outage is still recognised as a duplicate.

## 7. Network

- HTTPS only. The edge refuses an `http://` server address except on this machine (loopback, for tests).
- Proxy: `HTTPS_PROXY` / configuration, HTTP `CONNECT`, TLS end to end. Allow-lists should name the server host, not
  an IP address.
- The full list of outbound destinations is the server base URL (and the update source, outside this contract).

## 8. The AAS Studio server side

With `EDGE` empty (the default) it starts off and an admin turns it on in the screen — Settings → Remote collectors →
"Turn on remote collection" (2.7.0). `EDGE=on` is always on and `EDGE=off` always off; then the screen's switch is
locked. Never on in demo mode. It needs a store with runtime state (memory, folder or PostgreSQL — all of them). The
read interval it hands out is `COLLECT_INTERVAL` when set, otherwise 5 s.

**One-click connect (2.7.0)** — the screen's "+ Connect a collector" uses the routes below in one go. When the code is
made with the list shown at that moment and `approve: { revision }`, the device it registers reads exactly that list at
once (if the files change meanwhile it still reads what the person saw, and the screen says "the files changed after
approval"). The screen makes the collector's one-line install command
(`curl -fsSL https://github.com/waceinc/vexplor-edge/releases/latest/download/get.sh | sudo sh -s -- --server … --code …`).

| For people (login or API key) | |
|---|---|
| `GET /edge/status` | On or off, whether the screen may switch it (`switchable`), and the list now (`revision`, machines, tags) |
| `POST /edge/enable` `{ enabled }` | Admin session only. Switches it on a server with `EDGE` empty (409 where `EDGE` is set) |
| `POST /edge/registration-codes` `{ approve? }` | A one-time code for the caller's workspace — shown once, valid 24 h. With `approve: { revision }` (from `/edge/status`) it is approved in advance — refused (409) when the revision differs |
| `GET /edge/devices` | Devices of the workspace, with `changedSinceApproval` when the files changed after approval, who approved (`approvedVia` `code` · `person`) and the last batch (`lastSeenAt`, `samplesReceived`, `lastStatus`) |
| `GET /edge/devices/:deviceId/read-list-preview` | What approving now would grant, and its `revision` |
| `POST /edge/devices/:deviceId/approve` `{ revision, intervals? }` | Grants exactly the previewed list; refused (409) when the files changed meanwhile. `intervals` `{ <interfaceId or tagId>: ms }` (100 ms – 1 h) sets read intervals — re-approving with other intervals gives the edge a new revision |
| `POST /edge/devices/:deviceId/pause` · `/resume` · `/revoke` | Empty list from now on · read the approved list again · the device is refused from now on |

A device belongs to the workspace of whoever made its code and never sees other workspaces, even when an admin approves
it. Its list holds only files that workspace owns (shared files are readable but cannot take values). On a server that
splits workspaces, a device registered before the split is refused until it registers again. Registration is limited
to 10 attempts a minute per address and 120 per server. A changed list is not handed out until someone approves it again. The mock edge `scripts/mock-edge.mjs` is the
reference client (`node scripts/mock-edge.mjs --server https://… --code …`).

## 9. What this contract does not claim

It is a VEXPLOR contract, not an IDTA specification. The read list is derived from AID (IDTA-02017) submodels, but
supporting this contract does not mean full AID support — protocols and form fields the server cannot resolve are left
out of the list.
