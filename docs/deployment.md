# Running a public demo server — what you need and what to decide first

**English** · [한국어](배포_호스팅.md)

> For: anyone who, alongside the open-source release, wants to run **a demo server that anyone can try**
> Related: [install.md](install.md) (in-house installation) · [usage.md §12](usage.md) (accounts and API keys) · [SECURITY.md](../SECURITY.md) (known limitations) · [rules.md](rules.md) (validation rules)

---

## 0. First — a demo server and open source are **different things**

| | Open-source repository | Public demo server |
|---|---|---|
| What | Code. Anyone downloads it and runs it on their own server | One server we run |
| Restrictions | **None** | Demo account cannot download · periodic cleanup |
| Cost | Free | Server cost + maintenance |

**Building restrictions into the code means nothing.** The source is public, so anyone can turn `DEMO_MODE` off
or delete `apps/api/src/demo.ts`. Restrictions only take effect **on a server we run ourselves**,
and even there the purpose is not "tease people into signing up" but **the minimum safety for running a public sandbox**.

Put restrictions on people who download it and run it themselves, and they simply will not use it.
If the goal of open source is adoption, **keep restrictions on the demo server only**.

---

## 1. Demo server settings — a handful of environment variables

```bash
DEMO_MODE=on                  # run as a demo
AAS_DEMO_LOGIN=demo           # default: demo
AAS_DEMO_PASSWORD=0629        # default: 0629
AAS_DEMO_RESET_MINUTES=60     # delete files a visitor has not touched for 60 minutes (0 = never)
AAS_SIGNUP=on                 # turned on automatically in demo mode
AAS_SIGNUP_ROLE=editor        # role of people who sign up (viewer / editor) — admin is not accepted (everyone signing up would become an administrator)
AAS_LANG=en                   # startup log in English (empty = Korean)
```

Values written in `.env` take precedence over the defaults — if you copied `.env.example` as is, the values written there become the demo account.

With demo mode on, it behaves like this.

| | Demo account | Signed-up account |
|---|---|---|
| Open · edit · check · auto-fix | Yes | Yes |
| **View** the validation report | Yes | Yes |
| **Download** AASX · bundles · attachments | Blocked | Yes |

### Each sign-in gets its own workspace

The demo account is **one account shared by many people**. Splitting workspaces by account would put everyone in the same space,
and B would see the equipment AASX that A uploaded — this is a tool where files containing drawings, operating data and manufacturer names get uploaded.
So the workspace is separate **per sign-in**.

| Who | What they see |
|---|---|
| Visitor signed in with the demo account | What they uploaded **in this sign-in** + shared files (templates, read-only) |
| Signed-up user | What they uploaded with their account — still there after signing in again |
| Administrator · API key | Everything |

- Other people's files look **as if they do not exist**. Even with the address, the answer is 404, identical to a file that really does not exist
- Files a visitor has not touched for longer than `AAS_DEMO_RESET_MINUTES` (default 60 minutes) are deleted.
  **Files of signed-up users are not deleted**
- **Warning:** the demo account **starts empty on every new sign-in.** The sign-in is the workspace,
  so after signing out, or after 8 hours of inactivity ends the session, earlier uploads no longer appear (and are deleted soon).
  A banner on screen says so. To keep working, people sign up
- **Warning:** **the operator sees everything.** Files are hidden from other visitors, not from the server owner.
  Say so in the privacy policy

The enforcement point is the store. Guarding only the file number in the address would leak through the ways that cross files
(linking another file into a hierarchy · import from another file · bundles · the registry) — those ways are covered by tests too.

---

## 2. Server — four options

Cheapest first. Costs are for a single demo server.

| Option | Monthly cost | What you get | Catch |
|---|---|---|---|
| **1. Office PC + tunnel** (Cloudflare Tunnel) | **Free** | Public domain and HTTPS, automatic | Goes down when the PC is off. Becomes an opening into the company network |
| **2. Free-tier VM** (Oracle Cloud Always Free, etc.) | **Free** | A real server | Sign-up and card registration are tedious; cut off if the policy changes |
| **3. Cloud VM** (AWS Lightsail, a local cloud provider) | **About USD 7–20** | Stable. Region of your choice | You manage it (updates, backups) |
| **4. PaaS** (Fly.io · Railway · Render) | **From USD 5** | Deploying is as simple as `git push` | The database is billed separately. Limited region choice |

**Recommended: option 3, one cloud VM in your users' region.** Two reasons — responses are faster for those users,
and once sign-up **collects personal data**, transferring it to another country becomes one more legal step (section 4).

**2 cores / 4 GB / 40 GB** is plenty. AASX files are a few MB and concurrent users number in the tens.

---

## 3. Deployment — five steps

### Step 1. Server and domain

```bash
# after creating the VM and logging in
# Ubuntu's own repository: docker.io + docker-compose-v2
# Docker's official repository: docker-ce + docker-compose-plugin
sudo apt update && sudo apt install -y docker.io docker-compose-v2
docker compose version            # check that Compose v2 is available
```

You need one domain (a subdomain such as `aas.example.com` is enough). Point its A record to the VM's IP.

### Step 2. Code and settings

```bash
git clone <repository-url> vexplor-aas && cd vexplor-aas
cp .env.example .env
```

Fill in `.env` like this.

```bash
POSTGRES_PASSWORD=a-long-random-string      # if left empty, it will not start
APP_PORT=8080
AAS_ALLOW_OPEN=1
AAS_PUBLIC_URL=https://aas.example.com
AAS_LANG=en

DEMO_MODE=on
AAS_DEMO_RESET_MINUTES=60
AAS_SIGNUP_ROLE=editor
AAS_SETUP_CODE=a-value-nobody-knows         # prevents someone else from claiming the first administrator
```

### Step 3. Start it

```bash
docker compose up -d --build
docker compose logs -f app        # the setup code and the demo account are printed here
```

### Step 4. HTTPS — **do not skip this**

As soon as you accept sign-ups, **passwords travel in plain text** without it. One Caddy file handles certificates automatically.

```bash
cp Caddyfile.example Caddyfile    # change only the domain to yours
caddy run --config Caddyfile
```

Template: [../Caddyfile.example](../Caddyfile.example). Then bind the port in `docker-compose.yml` to `127.0.0.1:8080:8080` so nobody
gets in without going through the proxy. If you use nginx, pass `Host` and `X-Forwarded-Proto` ([install.md](install.md)).

### Step 5. Create the administrator account — **before turning on demo mode**

"Create the first administrator" appears **only while there are no accounts at all**. If demo mode is turned on first, the demo account
gets created and that screen no longer appears. So the order matters.

1. Start with `DEMO_MODE` **left empty** in `.env`
2. Browser → **Settings → Create the first administrator** (enter the setup code printed in step 3)
3. Add `DEMO_MODE=on` to `.env` and restart with `docker compose up -d`
4. The demo account (`AAS_DEMO_LOGIN` · `AAS_DEMO_PASSWORD`) is created at that point

With this administrator account, look at the people who signed up under **Settings → Manage accounts**.
(If you already started in demo mode, put `AAS_TOKEN` in `.env`, restart,
and call `POST /auth/users` with that key to create an administrator.)

---

## 4. Duties that come with accepting sign-ups — these weigh more than the server

The moment you collect names and contact details, you become a **personal data controller**. In Korea, at least the following applies
(Personal Information Protection Act); other jurisdictions, such as the EU under the GDPR, have their own rules — check the ones that apply to you.

| Item | What it means |
|---|---|
| **Privacy policy** | Publish what you collect, why, how long you keep it and when you delete it |
| **Consent to collection and use** | Collected on the sign-up screen (checkbox, implemented) — items, purpose and retention period shown right above it |
| **Retention and deletion** | Set a rule such as "deleted immediately on account deletion" and keep to it |
| **Access and deletion requests** | Show and delete on request. Account deletion is implemented (files included) · access and correction by email |
| **Security measures** | Password hashing (scrypt, implemented) · encryption in transit (HTTPS) · access logs |

Implemented: consent checkbox · account deletion · no contact data collected without a policy · no confirmation email (stated explicitly).
The privacy policy text is **not included in this repository** — the operator writes one for their own server (data protection officer, address and effective date included).

> **Changed 2026-10-06 — a server with a privacy policy collects name, company name and email at sign-up** (user request).

| `AAS_PRIVACY_URL` | Collected at sign-up |
|---|---|
| Empty (in-house default) | User ID · password (+ optional display name). There are **no** contact fields, and the server rejects them if sent |
| Set (public demo server) | User ID · **name · company name · email** (all required) · password + **consent to collection and use** (required) |

- Right above the consent box, state the **items · purpose · retention period · right to refuse** (Article 15 of Korea's Personal Information Protection Act)
- **Warning:** consent is **checked again by the server** (400 without `agreed: true`). The **time of consent is recorded by the server clock** (`consent_at`, added in database schema v7) — as evidence
- **Warning:** no confirmation email is sent. There is no mail server, and a fake check would lead people to trust the address as "verified"
- Company name and email are visible **to administrators only** (columns appear in the Settings → Manage accounts table)
- **Account deletion** (in Settings) deletes the account **together with the files that person uploaded** (2026-10-06 — before that, files remained).
  Files on a team-shared server have no single uploader on record and are not deleted
- Write and serve the privacy policy yourself (for example as a static file from the Caddy in front), and put its address in `AAS_PRIVACY_URL`

> Business decision (2026-10-06): **contact details are collected because the goal is leads (a prospect list).**
> **Warning:** sending **product promotion to the collected emails requires a separate optional consent** (marketing) —
> the current consent covers only "account management and answering inquiries". If you plan to send promotional email, add that consent item.

Check the parts that need legal judgment with your own counsel. This document is **a list of what to prepare**,
not legal advice.

---

## 5. After going live — what to keep up

| When | What |
|---|---|
| Every deployment | `git pull && docker compose up -d --build` |
| Daily (automated) | Database backup — `docker compose exec db pg_dump -U aas aas > backup.sql` |
| Now and then | Check `docker compose logs app` for errors and sign-up trends |
| Sign-up flood | Limited to 5 per hour per address · 30 per hour for the whole server. In demo mode (`DEMO_MODE=on`) sign-up is always open and `AAS_SIGNUP=off` does not close it — if it still floods, empty `DEMO_MODE` and restart |

### Remaining gaps — know them before going live

1. **The demo account starts empty on every new sign-in** (section 1) — to keep working, people must sign up
2. **The operator sees every visitor's files** — say so in the privacy policy
3. **A person has to write the privacy policy** — the program only checks that one is set
4. No email is sent, so **a forgotten password can only be reset by an administrator**

Already covered (checked 2026-10-04):
- **Workspaces are separated per sign-in** — people signed in with the same demo account cannot see each other's files
- OPC UA publishing **does not start at all in demo mode** (a public demo server is no place for a plant data port, secure or not)
- The demo account **cannot change its own password or delete itself** — before this, one visitor changing it locked everyone else out
- Sign-up rate limits (5 per hour per address · 30 per hour overall)
- Account deletion — removes the account and contact details while keeping the audit records

---

## 6. Summary — decide in this order

1. **Will you collect contact details?** → if so, every duty in section 4 applies
2. **Where will the server run?** → recommended: option 3, one VM in your users' region (about USD 7–20 a month)
3. One domain + HTTPS (Caddy) → 1 to 2 hours
4. Fill in `.env` and run `docker compose up -d` → 30 minutes
5. Go public
