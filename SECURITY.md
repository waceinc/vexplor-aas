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

1. **The OPC UA publishing port (default 4840) has no authentication.** It is off by default (`OPCUA_SERVER=on` turns it on).
   If you enable it, use it only inside a trusted network. It never starts on the public demo (`DEMO_MODE=on`).
2. **Shared by default.** Everyone who signs in sees the same files. Roles (admin, editor, viewer) decide *who may edit*,
   not *whose file it is* — the intended use is a team that trusts each other.
   To separate users, set `AAS_WORKSPACE=private` — each person sees only what they uploaded, and other people's files
   look as if they do not exist. **Administrators and API keys still see everything** (operations and machine
   integration). It is not a way to hide data from the operator.
3. **On the demo, every sign-in gets its own workspace.** The demo account is shared, but people signed in with it do
   not see each other's files. A **new sign-in starts empty** (earlier uploads are not shown again), and files of
   visitors who have been idle for a while are deleted. The operator can see them — keep confidential data on your own
   server; see [deployment.md](docs/deployment.md).
4. **Sessions live in server memory.** Restarting the server signs everyone out. One server instance is assumed.
5. **No e-mail is sent.** If someone forgets a password, an administrator resets it. Contact details entered at sign-up
   are not verified.

## Already mitigated

| Risk | Mitigation |
|---|---|
| Zip Slip · Zip Bomb | Paths and sizes are checked **before** extraction |
| XXE | External entities are not resolved, and internal entity expansion is limited |
| Passwords | Only scrypt hashes are stored; plain text is kept nowhere |
| Sessions | HttpOnly, SameSite=Strict cookies; Secure over HTTPS; a new key on every sign-in |
| CSRF | Writes that arrive with a cookie are checked against the request Origin |
| Password guessing | Five failures lock the account for five minutes |
| Framing · script injection | CSP · `frame-ancestors 'none'` · `nosniff` |
| Concurrent edits | ETags detect conflicts instead of overwriting |
