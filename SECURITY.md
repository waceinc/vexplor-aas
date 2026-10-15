**English** · [한국어](SECURITY.ko.md)

# Security policy

## If you found a vulnerability

**Do not open a public issue.** Until it is fixed, publishing it puts the people running this software at risk.

Report it through this repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting).
These details help us confirm it quickly:

- what you did and what happened (steps to reproduce)
- which version (the version number in the app header, or the commit)
- how it was started (Docker / from source, relevant environment variables)

We confirm and reply as soon as possible. After the fix we credit the reporter (or leave the name out if you prefer).

## Supported versions

Only the latest version receives security fixes. Please upgrade older versions.

## When you run it

The defaults assume **a single user on one computer**. Check the following before sharing it or opening it to a network.

| | |
|---|---|
| **Turn authentication on** | With neither accounts nor an API key, the server listens on that computer only (127.0.0.1). If you lift that safeguard with `AAS_ALLOW_OPEN=1`, **anyone who knows the address** can read and delete |
| **Put HTTPS in front** | Over plain http, passwords and login cookies travel in clear text. See [`Caddyfile.example`](Caddyfile.example) |
| **First-administrator setup code** | On a server open to the network, creating the first administrator asks for the code printed in the startup log. Without it, anyone on the same network could become the administrator first |
| **Long API keys** | At least 20 characters of letters, digits and symbols. Accepted only in the `Authorization: Bearer` header |
| **Database password** | Always change `POSTGRES_PASSWORD` in `.env`. The stack does not start if it is empty |

## Known limitations — left by design

Please read these before you deploy.

1. **The OPC UA publishing port (default 4840) is off by default** (`OPCUA_SERVER=on` turns it on). When on, it is
   secure: clients sign in with a server account over `Sign` or `SignAndEncrypt`, and an administrator trusts each
   client certificate once. `OPCUA_ALLOW_INSECURE=on` brings back the old port **without authentication** — use that only
   inside a trusted network while clients are migrated. It never starts on the public demo (`DEMO_MODE=on`).
2. **Shared by default.** Everyone who signs in sees the same files. Roles (admin, editor, viewer) decide *who may edit*,
   not *whose file it is* — the intended use is a team that trusts each other.
   To separate users, set `AAS_WORKSPACE=private` — each person sees only what they uploaded, and other people's files
   look as if they do not exist. **Administrators and API keys still see everything** (operations and machine
   integration). It is not a way to hide data from the operator. It needs a way to tell people apart: a server with
   `AAS_WORKSPACE=private` but no accounts and no API keys refuses file requests until the first administrator exists.
3. **On the demo, every sign-in gets its own workspace.** The demo account is shared, but people signed in with it do
   not see each other's files. A **new sign-in starts empty** (earlier uploads are not shown again), and files of
   visitors who have been idle for a while are deleted. The operator can see them — keep confidential data on your own
   server; see [deployment.md](docs/deployment.md).
4. **Sessions live in server memory.** Restarting the server signs everyone out. One server instance is assumed.
5. **No e-mail is sent.** If someone forgets a password, an administrator resets it. Contact details entered at sign-up
   are not verified.
6. **Integration subscriptions cover the whole server.** An administrator's webhook or MQTT subscription receives events
   from every workspace, also with `AAS_WORKSPACE=private`. Narrow a subscription to its files when one customer's
   data must not reach another system. See [integration.md](docs/integration.md).

## Already mitigated

| Risk | Mitigation |
|---|---|
| Zip Slip · Zip Bomb | Paths and sizes are checked **before** extraction |
| XXE | External entities are not resolved, and internal entity expansion is limited |
| Passwords | Only scrypt hashes are stored; plain text is kept nowhere |
| Sessions | HttpOnly, SameSite=Strict cookies; Secure over HTTPS; a new key on every sign-in |
| CSRF | Writes that arrive with a cookie are checked against the request Origin; `Origin: null`, and a missing Origin from a browser that reports a cross-site request (`Sec-Fetch-Site`), are refused. `CORS_ORIGIN=*` never counts as a trusted origin for writes |
| Password guessing | Five failures from one address block that address for five minutes; past 50 failures from any mix of addresses every try on that account is slowed down (not locked, so the owner can still sign in). Attempts are counted before the password is hashed |
| Account probing | Unknown and disabled accounts are checked against a decoy hash, so response time does not reveal which logins exist |
| Hash flooding | Password hashes run at most four at a time with a short queue; past it, 503 with `Retry-After` |
| First administrator | Created atomically in every store — two simultaneous setups cannot both succeed |
| Account details | Admin-only account routes accept an admin session, a full-access API key, or a server with no authentication at all — not a read-only key |
| Uploaded files as web pages | Thumbnails must be PNG, JPEG, GIF or WebP (checked by their bytes). Thumbnails and attachments are shown inline only when their bytes are a raster image or a PDF; anything else downloads as `application/octet-stream`. These responses carry a sandbox CSP |
| Framing · script injection | CSP · `frame-ancestors 'none'` · `nosniff`, also on error responses |
| Hostile AASX structure | Element nesting deeper than 64 levels, broken `[Content_Types].xml` or `.rels`, and unreadable bodies are refused as a 400 read error |
| Upload memory | The body cap follows `AASX_MAX_TOTAL_MB` (twice that, at most 512 MB); at most two bodies over 32 MB are read at once, otherwise 503 with `Retry-After` |
| Data folder paths | The folder store refuses package ids that are not plain names, so an id can never point outside the data folder |
| Concurrent edits | ETags detect conflicts instead of overwriting |
| Outbound connections (webhooks, MQTT) | DNS answer pinned for the connect; loopback, link-local, cloud metadata and the Azure platform address (168.63.129.16) always refused; private networks and plain http/mqtt only when listed in `AAS_INTEGRATION_ALLOW`; redirects not followed |
| Integration secrets | Webhook signing secrets and broker passwords sealed with AES-256-GCM; shown once on creation |
