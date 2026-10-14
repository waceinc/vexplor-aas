**English** · [한국어](사용법.md)

# VEXPLOR AAS Studio — User Guide

VEXPLOR AAS Studio is a tool to **create, edit, check and submit** the AASX file of a machine. Its reason to
exist is what AASX Package Explorer does not do — **checking against the KOSMO rules and fixing findings
automatically**. KOSMO here means the KOSMO Validator, the validator of the Korean submission program that
receives these AASX files. On top of that come a structure tree at process and company level, live value
collection (OPC UA · Modbus TCP · MQTT) and serving, and export of figures and tables for guidance documents.
The interface and everything the server writes are available in **English and Korean**, with a light and a dark theme (chapter 3).

> This guide is for **people who use the tool**. Installation is in [install.md](install.md), the checked rules are in [rules.md](rules.md).
> Screenshots show the new design (2026-10), light theme.
>
> **Slides for presentations and training**: `python scripts/make-manual-pptx.py` → `out/VEXPLOR_AAS_Studio_사용법.pptx` (built from the Korean guide, same order, with screenshots)

**Overall flow** — read in this order and you can build one machine from start to finish.

```
 ① Start → ② New → ③ Fill values · add elements · attach files → ④ Review findings → ⑤ Auto-fix
        → ⑥ Validation report → ⑦ Download AASX → (optional) group into company / process · collect live values
```

| Chapter | Contents |
|---|---|
| [1](#1-setup-and-running) | Setup and running — single user · company server |
| [2](#2-start-screen) · [3](#3-screen-layout) | Start screen · screen layout · language and theme · help |
| [4](#4-building-one-machine-start-to-finish) | **Building one machine — start to finish** |
| [5](#5-editing-operations) | Editing operations — context menu · order · rename · undo · history |
| [6](#6-parts-structure-bom) | Parts structure (BoM) |
| [7](#7-grouping-a-company-or-process) | **Grouping a company or process** |
| [8](#8-collecting-live-values-opc-ua--modbus-tcp--mqtt) | Collecting live values (OPC UA · Modbus TCP · MQTT) · value freshness · daily status · serving |
| [9](#9-file-management) | File management — list · bulk delete · continue working |
| [10](#10-rules-and-the-validation-report) · [11](#11-document-assets) | Rules and the report · document assets |
| [12](#12-sharing-on-the-company-network--accounts-and-api-keys) · [13](#13-troubleshooting) · [14](#14-known-limits) | Sharing · troubleshooting · limits |
| [Appendix](#appendix-a-common-findings-and-what-to-do) | Common findings · glossary |

---

## 1. Setup and running

### Single user — development mode

```bash
cd vexplor-aas                      # the repository folder
npm install && npx tsc -b           # once (Node.js 24 LTS recommended; 22 or later works)

npm run dev:api                     # ① API         http://localhost:8080
npm run dev:web                     # ② authoring UI http://localhost:5173  (in another terminal)
```

**Start the API first.** Then open **http://localhost:5173** in the browser.

> **Note:** started like this, **storage is in memory** — files you uploaded are gone when the server stops.
> To keep them, give a folder, e.g. `AAS_DATA_DIR=out/data node apps/api/dist/server.js` (single user),
> or use the company server setup (Docker) below. Either way, the basic rule is: **keep your results by using "Download AASX"**.

| To do this | Command |
|---|---|
| Turn on live value collection (OPC UA etc.) | `COLLECT=on node apps/api/dist/server.js` (chapter 8) |
| Turn on serving values (OPC UA server) | `OPCUA_SERVER=on …` (section 8-6) |
| Run the build on a single port | `npm run --silent build -w @aas/web`, then `WEB_ROOT=apps/web/dist node apps/api/dist/server.js` → http://localhost:8080 |
| Server startup log in English | `AAS_LANG=en node apps/api/dist/server.js` — the default is Korean. This is separate from the screen language (chapter 3, "Language and theme") |

### Company server — Docker

One command starts the **API, the authoring UI and the database** together. Data stays in the database across restarts.

```bash
cp .env.example .env               # ① settings — fill in POSTGRES_PASSWORD and AAS_TOKEN
docker compose up -d --build       # ② start (the first build takes a few minutes)
docker compose logs -f app         # ③ startup log — authentication and storage status appear here
```

Open **http://<server-address>:8080** (or the `APP_PORT` in `.env`). The UI and the API share one address.

| To do this | Command |
|---|---|
| Update to a new version | `git pull && docker compose up -d --build` — **without `--build` you keep the old UI** |
| Stop (data is kept) | `docker compose down` |
| Delete the data too | `docker compose down -v` — **cannot be undone** |
| The page does not load | Usually Docker Desktop on that server PC has stopped. Start Docker Desktop → `docker compose up -d` |

Set in `.env`: `POSTGRES_PASSWORD` (required) · `AAS_TOKEN` · `AAS_READONLY_TOKEN` · `AAS_SETUP_CODE` (chapter 12) ·
`APP_PORT` · `COLLECT` · `COLLECT_INTERVAL` · `COLLECT_RETENTION_DAYS` (chapter 8) ·
`OPCUA_SERVER` · `OPCUA_PORT` · `OPCUA_HOST` (section 8-6) ·
`AAS_ALLOW_OPEN=1` (several people on the company network without accounts or keys) · `AAS_LANG` (startup log language). Install package details: [install.md](install.md).

Put `AAS_LANG=en` in `.env` (or run `AAS_LANG=en node apps/api/dist/server.js` when starting directly) and the **server startup log**
is written in English. Leave it empty for Korean. The OS language of the server PC is not used.
The language of the screen and of server-written text (findings, report and so on) does not follow this value — it follows **the language each viewer picks**.

> After starting, open it in the browser and click **Settings ▾ → Create the first administrator** to switch to accounts (chapter 12).
> Once people sign in, **put HTTPS in front** (12-3).

### Opening files from others (XML)

An `.aasx` with XML inside also opens. It is **converted to JSON on import**, and the tool tells you so — files are always saved as JSON.
Both BaSyx and Package Explorer read JSON.

---

## 2. Start screen

![Start screen](images/manual/en/m01-first.png)

There are four ways to start.

| Button | When |
|---|---|
| **"Open AASX file"** | You have an `.aasx` (pick it on your PC) |
| **"New"** | Start from an empty file (chapters 4 and 7) |
| **"Open bundle"** | Open a reference bundle (ZIP) you received (section 7-7) |
| **"Start with a sample"** | You have no AASX yet — opens one fully filled machine (`RollFormingMachine_sample`) and a process structure. It is a practice copy; edit freely |

> If this is your first time, open the sample. "New" starts with **six empty submodels**, which is hard if you do not know yet what goes in them.
> With the sample open, **"Import from another file"** (section 4-4) copies its nameplate and technical data into your new machine so you only change the values.
> After the start screen you can reopen it any time with **File ▾ → Open sample**.

When the server **already holds files, the "Continue working" list comes first**. Pick the file you were working on there.

![Continue working](images/manual/en/m01b-welcome-list.png)

> **Note:** uploading the same file again with "Open AASX file" **creates another copy**, and the same name piles up in the list.
> Upload from your PC once; after that, pick it from the list. Clicking the logo to return to the start screen
> leaves your files where they are.

On your first visit the screen language follows the **browser language** — a Korean browser gets Korean, anything else gets English. To change it, see "Language and theme" in chapter 3.

---

## 3. Screen layout

![Main screen](images/manual/en/m02-layout.png)

There are three panes. Drag the handle between panes to change their width; **spare width goes to the middle (work) pane.**

| Pane | Contents |
|---|---|
| **Left — tree** | Everything in the file: AAS → AssetInformation · submodels → elements · ConceptDescriptions (term definitions). Type names (Property · SubmodelElementList …) are **exactly as in the specification** — the same words as KOSMO findings and Package Explorer, so you can compare them. The `✕ 3` · `⚠ 2` badges count errors and warnings below that node |
| **Middle — summary / editor** | With nothing selected: the file summary (counts, verdict) and structure panels. With an element selected: its properties and edit fields |
| **Right — collection** | Connection status and the current value of each tag (chapter 8). Leave it empty if you do not collect values |

### The header has two rows

![Header](images/manual/en/m03-header.png)

Frequent actions are out in the open; occasional ones sit in **menus (▾)**.

| Row | Contents |
|---|---|
| Top — *which file* | Logo "VEXPLOR AAS Studio" (click for the start screen) · **File ▾** · **file drop-down** │ (right) **errors / warnings chip** · "→ Serving" · **"? Help"** · **Settings ▾** |
| Bottom — *what to do with it* | ↶ Undo · ↷ · **Submodels ▾** · Auto-fix N │ (far right) **Export ▾** · Download AASX |

The bottom row appears once a file is open.

| Menu | Items |
|---|---|
| **File ▾** | Open AASX · New · Open bundle · Open sample · File list |
| **Submodels ▾** | Add submodel · Import from another file |
| **Export ▾** | Validation report · Document assets · Reference bundle (process files only) |
| **Settings ▾** | Language · Dark screen (Light screen) · Manage accounts (administrators) · My account · Sign out · Delete my account · Rules and conventions · Clear token (only in a browser that holds a token) |

The bottom row reads **left to right in the order of the work** — fix, check, export.
**There is always exactly one filled button** (black in the light theme, light in the dark theme) — "Auto-fix" while there is something to fix, "Download AASX" when everything is fixed.
That button tells you what to press next. Hover over any button to see what it does.

### Language and theme

**Settings ▾ → Language** opens the settings dialog. Choose **"한국어"** (Korean) or **"English"**.

![Settings — language](images/manual/en/m40-settings.png)

- If you have never chosen, the **browser language** decides — a Korean browser gets Korean; anything else (including unknown) gets English
- Your choice **is remembered in this browser.** It is not a server setting; each viewer has their own
- Changing the language reloads the page — your files stay, **only unsaved input is lost**
- Not just the screen: **text the server writes** follows the language too — findings, rule descriptions, the validation report, the bundle README, and error messages. Date and time formats follow it as well

| Stays as it is in English | Why |
|---|---|
| **Names and values from your files** (idShort, values, definitions …) | Translating them would change the file content |
| **Folder and file names of the submission bundle** (`01_UseCase문서/` etc., 7-7) | The submission structure defines those names |

**Settings ▾ → Dark screen** (in the dark theme: "Light screen") switches the colors. Light is the default; your choice is remembered in this browser.

![Dark theme](images/manual/en/m41-dark.png)

> The language of the server **startup log** is set separately by the environment variable `AAS_LANG` (chapter 1).

### Help — inside the app

Click **"? Help"** in the header (or press `F1`) to open the help panel on the right. **Topics for the current screen come first**; search by keyword in the box at the top.

- **"▶ Take the tour"** — a walk-through that points at the real screen one spot at a time. It appears once on your first visit and once when you first open a file (→ next · ← previous · `Esc` to stop)
- **"Show the getting-started list"** — open a file → review the check results → auto-fix → download, in order. Steps tick themselves off as you do them

### Summary — what you see first after opening a file

![Summary](images/manual/en/m04-summary.png)

- Badge next to the title: **"Equipment" / "Process / company"** — whether the file is one machine or a group. What you can add differs (chapter 7)
- **"Add to this file"** row — equipment: ＋ Submodel · ＋ Part / group: ＋ Equipment · ＋ Process · ＋ Submodel
- Tiles — number of submodels, elements, ConceptDescriptions
- **Verdict** — N errors / M warnings. For a new file it also **names the empty submodels** (the rules check form only, so empty submodels still give 0 errors)

### Finding things in the tree

![Find](images/manual/en/m15-search.png)

A file has more than 200 elements. Type in the **find box** above the tree and only matches remain — **name · type · value · semanticId · id**
(case-insensitive). Matching rows are highlighted in blue, and the path to them (their parents) stays visible. Press `Esc` or the clear button to reset.

> Examples: `RFL-2026` (a value) to find a serial number, `0173-1#02` (a semanticId) to collect every element that uses a standard dictionary.

---

## 4. Building one machine, start to finish

We follow one press machine, `PressMachine`, all the way through.

### 4-1. New file

**File ▾ → New** (or "New" on the start screen) → **"Equipment"**.

![New — equipment](images/manual/en/m05-new-equipment-form.png)

1. **Equipment name** — e.g. `PressMachine`. **Start with a Latin letter; only letters, digits and underscores.** The name goes into the id as is
2. **Required submodels 1–4 are added automatically** (fixed order — KOSMO rule)
3. **Optional submodels 5–11**: tick the ones that fit the machine (5 and 6 by default)
4. Machine-specific submodels go in the free-text field, comma-separated — e.g. `PressSafety`
5. Check the "This will create N submodels" line and click **"Create"**

> The total must be **6–8** (KOSMO-AAS-4). From 9 on, the file would be in error the moment it is created, so the form warns you first.

![Right after creating](images/manual/en/m06-new-equipment-created.png)

The file opens right away. It has only the skeleton (6 submodels) and **0 elements** — the verdict line names the
*empty submodels*. Now fill them.

### 4-2. Add an element — enter one value

In the tree, **right-click a submodel (e.g. DigitalNameplate)** → **"Add element"**. (The "Add element" button in the middle pane does the same.)

![Add element](images/manual/en/m07-add-element-form.png)

| Field | What to enter |
|---|---|
| Type | `Property` (one value) · `MultiLanguageProperty` (text per language) · `Range` (min–max) · `File` (attachment) · `SubmodelElementCollection` (group) … |
| New element name (idShort) | CamelCase — e.g. `ManufacturerName` |
| valueType | For Property and Range. `xs:string` text · `xs:int` integer · `xs:double` decimal · `xs:boolean` true/false · `xs:date` date |

**You can leave the semanticId empty.** The linter reports it and "Auto-fix" fills it per the conventions (4-8).

Click "Add" and the element appears in the tree; select it to enter a value.

![Element editor](images/manual/en/m08-element-inspector.png)

| Field | Purpose |
|---|---|
| Top text box | **The value.** MultiLanguageProperty has one field per language, Range has min and max |
| valueType | A select box — change it here if you did not set it on creation (e.g. temperature to `xs:double`) |
| Name (idShort) | Fix typos here (chapter 5, "Rename") |
| semanticId | An IRDI (standard dictionary) or your own IRI. The format is checked as you type |
| Duplicate · Delete | Only container elements (SMC, SML) have "Duplicate" (chapter 5) |

**"Save"** writes to the server immediately. There is no separate save button to look for.

### 4-3. Enter many values at once — the submodel value table

You do not have to click 40 elements and save 40 times. **Select a submodel** and its values appear as a table.

![Enter many values at once](images/manual/en/m12-submodel-bulk.png)

Edit row after row and click **"Save N changed"** once. Property values, the first language of multi-language properties and Ranges (`min~max`) are included.

With IDTA templates in the install folder (`AAS_TEMPLATES_DIR`), every row shows **what to fill**. Above the table you see "Required n · Empty required n · Collected n · Optional n" and the template it is based on.

| Tag | Meaning |
|---|---|
| **Required** | The template requires this item. Empty rows are highlighted and counted under "Empty required" |
| **Collect** | The collection link (AID, chapter 8) has a tag with the same name — the value comes from the machine, so nobody needs to type it, even if it is required |
| **Optional** | In the template, but may stay empty |
| (no tag) | Unknown — not in the template. The tool does not guess whether it is required or optional |

Tick **"Show only what to fill"** to keep only Required and Collect rows. For a submodel without a template, a line above the table says that the IDTA template is missing, so it cannot tell what is required.

**Fill from CSV…** — fills values in **many equipment files at once** from an equipment register (one machine per row), for every file that has this submodel.

![Fill from CSV](images/manual/en/m37-csvfill.png)

1. Paste the table (tab-separated text copied from Excel works too) or choose a CSV file
2. Files are found by the **machine-name column** (AAS name or file name). For each column choose the **target element** — columns whose name matches an element are preselected
3. The **preview** lists the values that change per file (before → after). Empty cells never erase a value. Rows whose file does not exist, whose file lacks the submodel, or that repeat a machine are skipped
4. **"Apply M values to N files"** — each file is saved on its own, so undo also works per file ("Undo")

### 4-4. Fill the skeleton fast — add submodel · import from another file

**Add submodel** — header **Submodels ▾ → Add submodel**. id, kind (Template), semanticId and administration are filled in per the rules.

![Add submodel](images/manual/en/m21-add-submodel.png)

**Import from another file** — header **Submodels ▾ → Import from another file**. Copies a whole submodel from another AASX already on the
server (a golden file or an IDTA template). Taking the nameplate and technical data from a similar machine and changing only the values is the fastest way.

![Import from another file](images/manual/en/m22-import.png)

- The id is **regenerated for this file's equipment name**, the **ConceptDescriptions it uses come along**, and the AAS reference is set automatically
- If the same name already exists, choose **"Replace"** (the current one is deleted) or **"Keep both"** (imported as `name_2`). If two remain, you get a warning
- Bring official IDTA templates in this way too. Built by hand, they lack the standard semanticIds and you get one finding per element
- **To avoid uploading every time**, put the `.aasx` in the server's template folder (Docker `templates/`, from source `AAS_TEMPLATES_DIR`) and it is loaded at startup

### 4-5. Attach manuals and drawings — attachments

The substance of a submission is **the document files inside HandoverDocumentation**. A path alone is an empty shell, so **attach the file itself.**

1. Select the document element (type `File`) in the tree — typing `DigitalFile` in the find box is quickest
2. In the middle pane, **"Attachment"** → **"Choose file"**
3. Done when the notice says the file was attached

![Attachment](images/manual/en/m16-attachment.png)

- The attached file goes into the downloaded AASX as `aasx/suppl/<file name>`, and the element value (`file:///aasx/suppl/…`) is **set automatically** — do not type it
- "Attached: <file name>" confirms it; "Remove attachment" takes it off. Large PDFs are received by the server, so the browser does not freeze

### 4-6. Thumbnail

A new file gets a **placeholder image**. Select **AssetInformation** in the tree to find the field for the thumbnail ("Thumbnail (defaultThumbnail)").
Upload a real photo of the machine (PNG, JPG) and the placeholder is cleaned up automatically. `assetKind` (must be Type) and `globalAssetId` are shown here too.

![AssetInformation](images/manual/en/m19-assetinfo.png)

### 4-7. Term definitions — ConceptDescriptions

These are the **definitions** of the names your elements use; an element's semanticId points here. Pick them under "ConceptDescriptions (n)" at the bottom of the tree.

![Concept description editor](images/manual/en/m18-cd-editor.png)

- Leave those from standard dictionaries (ECLASS, IEC CDD) as they are
- For placeholder definitions that "Auto-fix" created (equal to the idShort), replace the **English definition (required by KOSMO-CD-3)** with a real one — quote the development plan; do not invent
- The Korean definition is for documents (may stay empty). dataType and unit are copied into the document asset tables

### 4-8. Review findings → auto-fix

Click the **"N errors · M warnings"** chip in the header to open the list.

![Findings](images/manual/en/m09-findings.png)

| Level | Meaning |
|---|---|
| **Error** (red) | The KOSMO Validator will reject this. Must be 0 before submission |
| **Warning** (orange) | Passes submission, but worth knowing (standard-tool compatibility etc.) |
| **Info** (collapsed) | Nothing to fix — just facts |

Findings of the same rule are grouped on one card; click an item and **that element opens in the tree.** Items marked "Fixable automatically" are solved with one click.

Click **"Auto-fix N"** (the filled button) and a **preview dialog appears first, before anything changes** — each item shows **what changes · before → after**, and only **ticked items** are applied.

![Auto-fix preview](images/manual/en/m10b-fix-preview.png)

| Column | Meaning |
|---|---|
| ☑ | Apply or not. "Select all" toggles everything |
| Rule · target | Which rule on which element |
| What | One line on how it is fixed |
| Before → after | The value before and after (hover to see it in full). Filling something missing shows "(none) → value"; a removal shows "value → (removed)" |

- Click "Apply N selected" to fix. It runs several rounds and also catches follow-up findings that were hidden behind the first ones
- **Fixable warnings are listed too** (AASd-120 etc.) — untick them if you do not want them
- **What cannot be fixed automatically** is folded below the dialog, with the reason — anything that needs an invented value or definition is a person's job. The "N" on the button is **the number that will actually be fixed** (computed without saving when the file opens). If only unfixable items remain, the button is disabled and its tooltip says so
- After applying, a bar at the top shows **fixes · rounds · errors remaining**. If something went wrong, **"↶ Undo"** once takes you back

![Auto-fix result](images/manual/en/m10-fix-banner.png)

#### Fixes that move IRIs — the relocation ledger

Three rules (`KOSMO-SM-3` · `KOSMO-SME-3` · `KOSMO-CD-2`) move the semanticId to **your own IRI** (`smart-factory.kr`).
**The reason is that the KOSMO Validator rejects official IDTA IRIs (`admin-shell.io`)** (measured on 20 machine files: 167 types, 1,358 references).
This collides head-on with the KTL guideline (KTL = Korea Testing Laboratory), which says "keep IDTA IRIs unchanged", so the choice is **"pass KOSMO first, but keep it reversible"**.

- The preview first says how many of the fixes move official IDTA IRIs to own IRIs
- The originals are kept in the **relocation ledger** (`/aasx/_idta_relocated_iris.json`), which **goes into the downloaded .aasx** and is also listed as a table in the validation report
- In the summary, the line about official IDTA IRIs moved to own IRIs has **"Restore original IRIs"** — one click back if the interpretation of the rules changes (restored IRIs are errors again under the KOSMO-first policy — then set the policy to `iriConflict=preserve`)

![Relocation ledger](images/manual/en/m10c-ledger.png)

- To keep the official IRIs, use the policy `iriConflict=preserve`; to protect only the terms of standard templates (AID etc.), use `standardTemplateSemantics=preserve` (chapter 10)
- The **definition** of a ConceptDescription created by `KOSMO-SME-3` is a **placeholder** (the idShort) — replace it with a real definition in 4-7 to pass KOSMO-CD-3

How to handle the remaining findings is in [Appendix A](#appendix-a-common-findings-and-what-to-do).

### 4-9. Validation report

**Export ▾ → Validation report** opens the report in a new tab. **Print it from the browser and you have a PDF for submission.**

![Validation report](images/manual/en/m34-report.png)

It contains the summary, counts per rule, the list of findings (errors → warnings → info, with location and action) and **which interpretation of the rules was used**.

> The report is the result of **this tool's own linter**, not the output of the KOSMO Validator. The report says so too.

### 4-10. Download AASX — submission checklist

Save with **"Download AASX"**. Your edits and attachments are included. **If errors remain, it asks once** — fine for an intermediate save.

1. **0 errors on screen** — warnings may remain
2. Check the file you saved with "Download AASX" as follows
3. Standard validator — `out/venv/bin/python scripts/aas-test-engines.py downloaded-file.aasx` (install: `python3 -m venv out/venv && out/venv/bin/pip install aas-test-engines==1.0.3`)
4. If you plan to load it into BaSyx — `out/venv/bin/python scripts/basyx-check.py downloaded-file.aasx --expect-submodels 7`
5. **Submit to the KOSMO Validator** — the Validator makes the final acceptance decision
6. Print the report to PDF and keep it

---

## 5. Editing operations

### Tree context menu ("⋯")

Hover over a tree row and **"⋯"** appears at the right end. Click it or **right-click** to see what you can do with that row.

![Context menu](images/manual/en/m14-context-menu.png)

| Row | Menu |
|---|---|
| Submodel · container element (SMC, SML, Entity) | Add element · **Duplicate** · Move up / down · Delete |
| Single element (Property etc.) | Move up / down · Delete |
| Top AAS | Add submodel · ＋ Part (group file: ＋ Process · ＋ Equipment · Add submodel) |
| ▦ process · ⚙ equipment (group file) | Chapter 7 |

**Duplicate** exists only for container elements — for adding a second certification mark, document or contact **with all elements and values inside**.
The copy appears right below as `name_2`.

### Reordering

**Drag** an element in the left tree and drop it between siblings (a blue line shows where it lands). Without a mouse use `Alt+↑` / `Alt+↓`, or the context menu.
The element order is the order in documents (guidance tables). Moving to a different parent is not accepted.

### Renaming (idShort) — two cases are refused

Select an element or submodel and you get the **"Name (idShort)"** field. Edit it and click "Rename". Two cases are refused.

| Refused | Why |
|---|---|
| **The name already exists at the same level** | With duplicate sibling names, the wrong element gets edited silently (AASd-022) |
| **List children** (like `MarkingsEntry_0`) | List children are addressed by position. Naming them makes BaSyx drop the whole branch (AASd-120). The name field is not shown at all |

### Undo · redo

![Undo](images/manual/en/m11-undo-header.png)

**"↶ Undo"** (`Ctrl+Z`) · **"↷"** (`Ctrl+Shift+Z`) in the header. Value edits, deletions, reordering, duplicates, auto-fix, imports —
**any change is undone with one click** (30 steps). Hover over the button to see what will be undone.

- The undo list **lives only as long as the server runs.** For older states use "History" below
- Removing a file from the list cannot be undone

### History — go back to a point in time

Select a submodel and click **"History"** to see its change history. **"Restore this version"** returns it to that state.
The restore itself is recorded and can be undone again. History is stored on the server.

![History](images/manual/en/m17-history.png)

### Editing together

If someone else changed the same submodel first, your save is refused with *"This submodel was changed elsewhere first. Your edit was not saved."*
Click **"Reload"** and continue. Nobody's edits are overwritten.

---

## 6. Parts structure (BoM)

Below the summary of an equipment file: **"Parts (BoM)"** — where you record which parts the machine is made of.
It is stored in the file's **HierarchicalStructures submodel (IDTA 02011)**.

![Parts structure](images/manual/en/m20-bom-panel.png)

- **"＋ Part"** on the equipment row — a name alone is enough (parts usually have no file of their own). If a part has its own AASX, pick it from the uploaded files or use "Import from PC"
- **"＋ Assembly"** — a level that groups parts (module, assembly). E.g. `J2Reducer` · `J2Motor` under `Joint2Module`
- Several identical parts get a **quantity** (`×12`) — the standard field `BulkCount`, like the 12 RollStandUnits in the golden file
- "✕" removes one. Removing an assembly moves its parts one level up

The same content shows in the left tree as a standard Entity tree inside the **HierarchicalStructures submodel** — that is what the file really contains; this panel is where you edit it.

---

## 7. Grouping a company or process

A group file bundles several machines as **company → process → equipment**. In the standard, an AAS can describe not only a machine but also a process, line or plant.

### Separate files, linked by reference

A group file **does not contain the machine details.** It only points to each equipment file through one address, the `globalAssetId`.

```
SampleFactory.aasx  (group)
   ▦ PressLine
      ├ RollFormingMachine ×2  →  …/asset/RollFormingMachine/1/0   ← the Asset of 01-롤포밍기.aasx
      └ Cutter01 (planned)     →  …/asset/Cutter01/1/0            ← links up once a file with this name exists
   ▦ WeldingLine
```

Changing a machine changes only the equipment file; the group file stays as is — **one original, in one place**.
**So when you hand it to someone, give the group file and the equipment files together.**

### 7-1. How to create one

**File ▾ → New → "Group (company/process)"**

![Create a group](images/manual/en/m23-new-group-form.png)

1. **① Name** — company, process or line, the name decides (e.g. `SampleFactory`)
2. **② Structure — draw it as a tree.** One rule:
   - On the company row, **"＋ Process"** → type the process name and press Enter (several in a row, "Close" to finish)
   - On that process row, **"＋ Equipment"** → add machines, in one of three ways:

   | Way | When |
   |---|---|
   | **Pick from uploaded files** | The equipment AASX is already on the server |
   | **"Import from PC"** | The equipment AASX is in a folder on your PC — it is selected as soon as it is uploaded; just click "Add" |
   | **Name only** | There is no file yet — it gets a **"Planned"** badge and links up automatically once you create an equipment file with that name |

   - For several identical machines enter a **quantity** (×2). If you will collect values per machine, turn on **"per unit"** and separate files `name_1`, `name_2` are created (below)
   - "✕" removes; removing a process moves its machines one level up
   - To group processes into a line: on the company row **"＋ Line"** → on that line row **"＋ Process"** → on that process row "＋ Equipment". Lines go directly under the company only
3. The tree is the preview — click **"Create"**

> The screen draws **company → (line →) process → equipment**; the parts below a machine are in the equipment file's "Parts (BoM)" — five levels in all. A line is stored in the file with a semanticId (own IRI `…/cd/Line/1/0` + IDTA Node), and its term (ConceptDescription) is added too. Names start with a Latin letter, use letters / digits / underscores, are at least 2 characters, and must not start with `HasPart_`.

### 7-2. After creating

![Group file](images/manual/en/m24-group-opened.png)

- Right below the summary: the **"Processes and equipment"** panel — add and remove with **the same tree editor** as at creation
- Two rows of tiles — structure (number of processes and machines) and totals (submodels, elements and CDs including the machines in it). Machine files that are not open are left out of the totals, and that is shown
- A group gets **none** of the four required equipment submodels (nameplate etc.) — it starts with a single hierarchy (HierarchicalStructures) submodel. Use "Add submodel" if you need more

### 7-3. Reading the tree

![Group tree](images/manual/en/m27b-group-tree.png)

| Row | Meaning |
|---|---|
| **▦ PressLine** `LinkedAsset` | A process (level). It has no file |
| **⚙ RollFormingMachine ×2** `LinkedAsset` | A machine. Expands when its file is uploaded |
| **▤ BOM (3)** under ⚙ | That machine's parts — collapsed. Expand for `· Uncoiler Part …` |
| **DigitalNameplate …** under ⚙ | A submodel **of that equipment file.** You can edit it right here; saves go to the equipment file (a link notice above the editor) |
| ⚙ Cutter01 (planned) | A machine without a file yet — name only |
| **HierarchicalStructures** `Submodel · Company and process structure` | What the file really contains. The ▦ and ⚙ rows above are a readable drawing of it |

> **Why both the machine and the company have HierarchicalStructures** — the subject differs. The machine's says *what this machine is made of* (parts),
> the company's says *what this company is made of* (processes, machines). In the standard each level's AAS describes the level just below it, so the hierarchy nests recursively.
> In the company file that row carries the green label **"· Company and process structure"**.

**Findings are collected in one place as well** — the header chip and tree badges include the findings of the equipment files (with the file name), and clicking one takes you there.
"Auto-fix" works only on the open file — to fix a machine's findings, open that equipment file.

### 7-4. The "⋯" menu on ▦ and ⚙ rows

![Process row menu](images/manual/en/m25-group-tree-menu.png)

| Row | Menu |
|---|---|
| Top AAS (company) | ＋ Process · ＋ Equipment · Add submodel |
| ▦ process | **＋ Equipment** · Remove from this structure |
| ⚙ machine (has a file) | **Add a submodel to this equipment** · **Open this equipment file** · Remove from this structure |
| ⚙ machine (name only) | Remove from this structure |

"Remove from this structure" only takes it out of the list; **the file is not deleted.**
**Click** a ⚙ machine row and the middle pane shows the actions for that machine:

![Equipment context](images/manual/en/m27-group-asset-context.png)

### 7-5. ×quantity vs per unit

| | Meaning | When |
|---|---|---|
| **×n** | n machines of the same catalog type — a quantity | The goal is the structure and parts demand. Only facts that all n machines share (manufacturer, specs) are true |
| **per unit** | Files `name_1 … name_n` — **the original file is copied whole** (submodels and attachments included, id = unit name) | The goal is collecting measured values per machine. Values and collection addresses are edited per unit |

If you add a machine that has a collection link (AID) as ×2 or more, the tool warns you — its collected values belong to "one of them" only.

**Type changes into units** — unit files split off per unit stay linked to the original (type) file. When the type file changes, the **"Type file" card** in the unit file's summary
shows "Review type changes (n)". The dialog lists each change (location · change — Added / Removed / Value changed · type value at split · current type value · this unit's value), and only **the rows you select** are applied with "Apply n selected row(s)".

![Type file card and type change review](images/manual/en/m39-derivation.png)

- Values edited on the unit (serial number, collection address etc.) are not overwritten; they are shown as "Edited on this unit — kept as is" (and cannot be selected)
- Applying can be undone and redone with "Undo" / "Redo". Rows you did not select show up again next time
- Units created before this feature are linked with "Link to a type file…" on the card — the baseline is the type as it is when you link. "Unlink" stops receiving type changes
- The type snapshot is kept next to the file and is **not exported into the AASX** (models and submission files are unchanged)

### 7-6. Three check rules — catching broken links

| Rule | What it checks |
|---|---|
| **HIER-1** | Entry node (EntryNode) and ArcheType exist |
| **HIER-2** | The Asset address each child points to exists · nothing contains itself · the same machine is not listed twice |
| **HIER-3** | Each child has a matching HasPart relationship |

Cycles (A contains B and B contains A) are refused by the server. When you delete an equipment file that a group points to, you are told first (chapter 9).

> **Note:** **copying** equipment submodels into the group file (embedding) is not used — the submodel count grows and gives 78 findings such as KOSMO-AAS-4 (measured).
> Files are linked by reference and joined **only on screen**.

### 7-7. Reference bundles — a submission package per process (2026-09-30)

A **reference bundle** of the manufacturing data standardization program is a **package that groups machine deliverables (AASX, guidance) per process** (7 bundles).
The process file is the backbone of the bundle. In a process file: **Export ▾ → Reference bundle**.

![Reference bundle](images/09-레퍼런스번들.png)

| Section | Shows |
|---|---|
| Five numbers | Machines (files, planned) · pre-check (+ **standard AASd-120** count) · shared items · points to confirm · evidence of real operation |
| ① Structure and readiness | A card per machine and process — file, version, pre-check. Dashed = **planned**, ⚡ = a **demo copy** with a collection link |
| ② Data linkage | A **matrix that joins operating data by semanticId** — ● same name · orange ● different name · **≠** same name with different semanticIds (not joined) |
| ③ Evidence of real operation | Collection records — material that stands in for a live demo (below) |
| ④ Documents and attachments | Where Use-Case documents, guidance and references go (below) |
| ⑤ Points to confirm | Where trusting the semanticId alone goes wrong |

![Data linkage matrix](images/10-번들연계매트릭스.png)

> **Note:** **linking by semanticId alone is wrong** (measured on the program's 30 reference models). One ECLASS IRDI (`0173-1#02-ABC132#004`)
> is used for MachineState, AlarmCode and JudgmentResult alike. Record links as **path + semanticId pairs**, and a person decides whether to treat them as the same.

The card's **"Standard AASd-120 n"** — KOSMO does not check it, but the standard validator (aas-test-engines) reports it as an **error** and BaSyx drops
everything below it. Open the equipment file and remove them with "Auto-fix" — this does not affect KOSMO (measured: machine no. 28, 7 items → 0 standard errors, element count unchanged).

#### Export · open

Choose the bundle code (RB01–07), title, version, evidence level and evidence period, then **"Export bundle (.zip)"**.
The folder names inside the bundle are fixed by the submission structure and stay in Korean in the English UI too.

```
RB01_생산최적화품질관리_v1.0.0/
├─ README.md               structure tree · model table (version, hash) · evidence of real operation · how to reproduce · documents added by people
├─ bundle-manifest.json    SHA256 per model and attachment · evidence summary · evidence level
├─ 00_공정구성/            process file (not submitted as a reference model)
├─ 01_UseCase문서/         writing guide + added documents
├─ 02_참조모델/            equipment AASX
├─ 03_가이던스/            list of what to add + added guidance
├─ 04_데이터연계정의/      linkage draft CSV · points to confirm
├─ 05_샘플데이터/          collected values per unit (CSV)
└─ 06_검증결과/            pre-check report (for reference) · collection record (HTML)
```

- **Same content, same hash.** If the hash changes when you export again, a model has changed
- **File ▾ → Open bundle** with the ZIP uploads the processes and machines in one go and shows `hash match n/n`
- **Round trip:** opening a bundle and exporting it again **keeps the documents people added and the collection records.** Replacing only the models with a new version and exporting again (the January sync) relies on this
- The tool **does not write Use-Case documents or guidance.** It only creates the folders and the places to fill
- The KOSMO Validator checks **each machine's AASX when you create it.** Bundles have no official validator; the ✓ on screen is a **reference mark** from rechecking the included models. The bundle itself is checked by hash comparison, process structure (HIER), data linkage and evidence of real operation

#### Evidence of real operation — for submissions where a live demo is not possible

![Evidence of real operation](images/11-실동작증빙.png)

The machines in a bundle are types, so they have no values. Values accumulate on **units** created with "per unit". A unit carries the standard field
`derivedFrom` (→ its original type), so when you export the bundle, **collected values of units derived from that type are included automatically**.

1. Split the bundle's machine per unit, or open a demo bundle that contains unit files together with it
2. Give the unit a collection link (a real PLC or "Connect a virtual PLC (simulation)") and collect for a few minutes to a few tens of minutes — automatic with `COLLECT_INTERVAL=5`
3. When section **③** of the bundle shows a count, choose the **evidence level** (A field / B reproduction / C simulation) and **evidence period** (all, last N minutes), then export

![Collection record](images/12-수집기록서.png)

- `06_검증결과/수집기록.html` — collection link, period, count, statistics and trend per item, status distribution (RUNNING 85% etc.). Print it for a PDF
- **Real PLC addresses are masked** (`opc.tcp://(비공개):4840/…`). Bundles are published on GitHub
- If you reopen a bundle and have collected nothing new, **the previous bundle's collection record is carried over** (the card says "Carried over"). New collection replaces it entirely
- Collected values are not written back to the model (value sync option A)

#### Documents and attachments — Use-Case, guidance, references

In section **④** of the bundle, pick a folder and click **"Add file…"**. The file goes into that folder of the bundle ZIP and its hash is recorded in the manifest.
**It survives reopening and re-exporting the bundle.** It is not mixed into the process file (AASX), so the process file hash does not change.

- Folders you can add to: `01_UseCase문서 · 03_가이던스 · 04_데이터연계정의 · 05_샘플데이터 · 06_검증결과`
- **Files the tool generates** (README, manifest, reference models, pre-check) cannot be added (they are regenerated on every export)

---

## 8. Collecting live values (OPC UA · Modbus TCP · MQTT)

If the file has an **AssetInterfacesDescription (AID)** submodel, the right pane shows the collection table.
The AID defines **where to connect and what to read** (address, NodeId, register, topic) — it is an IDTA standard template, so no separate mapping table is kept.

| Protocol | Endpoint | Read address (href) | Notes |
|---|---|---|---|
| OPC UA | `opc.tcp://host:4840` | NodeId `ns=1;s=Machine.MotorSpeed` | "Load from equipment" browses the tags |
| Modbus TCP | `modbus+tcp://host:502/1` (last number = unit ID) | `40` · `1/40` · `1/40?quantity=2` | Choose the register kind (holding · input · coil · discrete input) and data type per row. Conventional addresses like `40001` are converted to kind + zero-based address |
| MQTT | `mqtt://user:password@host:1883` · `mqtts://…` | topic `plant/press/temp` (no wildcards) | Reads the **last value** the device sent. A topic that has not arrived yet shows "Waiting for a value" |

The Modbus and MQTT notation follows the W3C WoT bindings (used by the AID), and the tool reads them itself without external libraries (read only — it never writes to the machine).
Vendor-specific protocols such as LS XGT FEnet are not supported yet — enable the machine's Modbus TCP or OPC UA server instead.

The server must be started with **`COLLECT=on`**.

> **Note:** **collected values are not written back to the model (AASX)**, because the deliverable is a type. Values go into a time-series store only; the file stays as it is.

### 8-1. Create a collection link

Without an AID, the right pane shows **"Create collection link"**.

![Create collection link](images/manual/en/m30-aid-new-browse.png)

1. **① Endpoint of the machine (PLC)** — e.g. `opc.tcp://192.168.0.50:4840` · `modbus+tcp://192.168.0.20:502/1` · `mqtt://broker:1883`. **This is not the address the tool itself serves on (8-6)** — the tool blocks that
2. **"Load from equipment"** (OPC UA) — connects to the machine and browses its tags. Current values and data types are shown so you can check what each one is. Nothing is changed. Modbus TCP and MQTT have no browse; add them by hand or by pattern in step 3
3. Tick the tags you need and click **"Add N selected"**. To type them in, use "+ Enter manually" (tag name · NodeId `ns=1;s=Machine.MotorSpeed` · unit)
   - For many tags of the same shape, use **"+ Many from a pattern"** — name template (`Zone{i}_Temp`) · address template (`ns=1;s=Zone{n:2}.Temp`, `{n}` for Modbus) · start · end · step. `{n}` is the number (from start, by step), `{i}` is the position (from 1), `{n:2}` pads the number with zeros to two digits

   ![Many from a pattern](images/manual/en/m38-tag-pattern.png)
4. **"Create"** — an AID submodel (IDTA-02017) is created per the specification

> **Note:** name tags **the same as the model elements (idShort).** Then they land in the right place when served through the standard API (8-5).
> If names do not match, the tool tells you how many of the tags match a model element.

With an existing link, use "Edit link" to change it, or "Delete link" if you no longer need it (values already collected are kept).

### 8-2. Collecting

Click **"Collect"** to read immediately; the table shows the latest values and times.

![Collect](images/manual/en/m28-collect.png)

| Status | Meaning |
|---|---|
| (green) **Connected** | The last collection connected and read successfully |
| (yellow) **Connected · N bad tag(s)** | Connected, but some tags could not be read (NodeId typo etc.). That row shows **"Read failed — reason"** |
| (red) **Connection failed** | Could not reach the server — address or firewall |
| (grey) **Not collected yet** | Never connected yet |
| "Waiting for a value" | Connected and read, but no value has arrived yet — **this is not a fault** |

The status is **the result of the last real connection attempt** — nothing is guessed. Times are this PC's local time.
"Address list" exports the current table as CSV — the list you hand over for commissioning and acceptance.

#### Value freshness — live · stale · no value

Even when the status says "Connected", you still need to know when each value arrived. The header row of the collection table splits the items into three counts.

![Value freshness](images/manual/en/m35-freshness.png)

| Shown | Meaning |
|---|---|
| **Live n** | The value arrived within the freshness window |
| **Stale n** | There is a last value, but nothing has arrived since for longer than the window. The time cell of that row is also marked "stale" |
| **No value n** | Nothing has ever arrived |

- The time cell shows **how long ago the value arrived**, e.g. "just now · 12s ago · 5 min ago · 3 h ago · 2 d ago". Hover to see the receive time and the equipment time
- The screen re-evaluates this **every 15 seconds** — "n min ago" and stale marks update even when no new value comes in
- **Freshness window = the larger of 5 minutes and 3 × the automatic collection interval.** Example: `COLLECT_INTERVAL=30` → 5 minutes; `COLLECT_INTERVAL=600` (10 minutes) → 30 minutes. Without automatic collection it is 5 minutes. Hover over the header row to see the current window in minutes
- The judgment is based on **the time this tool received the value.** The equipment timestamp only moves when the value changes, so a tag with a constant value would look stale even though it is read fine every time (only old records without a receive time fall back to the equipment time)

### 8-3. Testing without a real PLC — the virtual PLC

You can go all the way without hardware.

```bash
node scripts/plc-simulator.mjs                                   # terminal ③ — virtual PLC (14840)
node scripts/make-demo-aasx.mjs                                  # → out/demo/롤포밍기-수집시연.aasx
COLLECT=on LINT_STANDARD_TERMS=preserve node apps/api/dist/server.js
```

Open the demo file and click "Collect". Or, in any equipment file, enter **`opc.tcp://127.0.0.1:14840/UA/RollFormingMachine`** in "Create collection link" and click "Load from equipment".

| Tag | Behavior |
|---|---|
| MotorSpeed · LineSpeed · MotorTemperature | Values that fluctuate over time |
| ProductionCount | Keeps increasing |
| AlarmActive · MachineState | An alarm for 5 seconds every 40 seconds |
| **BrokenSensor** | **A deliberately broken tag** — shows that the others keep coming in when one fails |

To switch to a real PLC, **change only the address**.

#### One button — "Connect a virtual PLC (simulation)" (2026-09-30)

No real PLC needed. Open an **equipment file** without a collection link and the right pane offers **"Connect a virtual PLC (simulation)"**.
It makes the built-in virtual PLC publish tags **named exactly like the machine's operational data (OperationalData)**, creates the collection link (AID)
and collects once — Connected. This is how someone who received a reference bundle **reproduces it themselves** (7-7).

- Values fluctuate around the example values written in the model. Only operating states (…State), alarms, judgments (OK/NG) and counters (Count, Energy) are recognized by name
- **These are simulated values.** The collection link is named "Virtual PLC (simulation)". Say so in demo screenshots and documents
- The AID is added to the file, which makes it a **demo copy**. To keep the reference model you submit unchanged, first create units with "per unit" (7-5) and do it there
- It does not attach to a machine already linked to **another address** (a real PLC). Process (group) files have no such button — collection happens on equipment
- The port is `SIMULATOR_PORT` (default 14850). If the script version below already runs on that port, you are told to close that window

The **script version**, which simulates several machines at once, follows the same rules.

```bash
node scripts/plc-simulator.mjs 14850 --from 03-SPR장비-뿌80.aasx --from 28-flowdrillscrew(FDS)장비.aasx
#   address: opc.tcp://127.0.0.1:14850/UA/Simulator   (one object per machine)
```

### 8-4. Automatic collection · cleaning up old values

With `COLLECT_INTERVAL=30` (seconds) the server collects every 30 seconds while it runs (*"Automatic collection on — every 30 s · last …"*).
With `COLLECT_RETENTION_DAYS=180`, older values are deleted (Docker default 180 days; started directly, values are kept forever). The model is not touched.
Age is judged by **the time this tool received the value** — a constant tag keeps an old equipment timestamp, so judging by equipment time would delete values just received.

**Daily status** — below the collection table there is one row per machine, a bar covering **24 hours from 08:00** (a process file shows one row per linked machine).
It is colored Running (green) · Stopped · Alarm · Power off · Undetermined (hatched) · No data, and the time per status is written under the row. ◀ ▶ move between days ("Previous day" · "Next day"). Before 08:00 the bar shows the day that started at 08:00 yesterday.

![Daily status](images/manual/en/m36-daily-states.png)

- The status tag is picked by name (Status · State · MachineState · OperatingState and their Korean equivalents …); if no single tag matches, choose it in the row with "Choose status tag"
- The value → status mapping is changed in **"Status rules"**. A value equal to one of the words counts as that status (comma-separated, case and spaces ignored). Example: if the customer's machine sends alarms as `3`, add `3` to Alarm. "Reset to default rules" goes back. Values not in the rules are not guessed — they are "Undetermined". The rules are kept in this browser only

| Status | Default rule (these values) |
|---|---|
| Running | 가동 · 운전 · 정상 · 생산 · run · running · auto · production · on · true · 1 |
| Stopped | 정지 · 대기 · stop · stopped · idle · standby · hold · off · false · 0 |
| Alarm | 알람 · 이상 · 고장 · 비상 · alarm · fault · error · trip · emergency |
| Power off | 전원꺼짐 · 전원off · poweroff · shutdown |

(The Korean words are device values to match against, not screen text, so they are the same in both languages.)

- One value holds until the next value, at most for the freshness window (the larger of 5 minutes and 3 × the collection interval, 8-2). After that it is "No data"

### 8-5. Exposing current values to other systems (REST)

```
GET …/submodels/{submodel}/$value            → the values written in the file
GET …/submodels/{submodel}/$value?live=true  → with live values from the machine applied on top
```

Live values are applied only with `live=true` — mixing file values and live values without telling which is which would be worse. To be applied, the AID tag name must equal the element idShort.

### 8-6. Serving values — the tool becomes an OPC UA server

```
[Machine / PLC] ──▶ [this tool] ──▶ [MES / SCADA]
           receive (8-1 to 8-4)   serve (8-6)
```

REST answers only when asked. For several upstream applications to **be notified when values change**, serve them over OPC UA (subscriptions).

```bash
OPCUA_SERVER=on OPCUA_PORT=4841 OPCUA_HOST=<this machine's IP> node apps/api/dist/server.js
```

| | |
|---|---|
| On screen | The header shows the **"→ Serving · N variables"** chip. Click it for the address to hand out |
| From the command line | `node scripts/opcua-browse.mjs opc.tcp://<server>:4841/UA/AAS` (`--watch` subscribes too) |
| Port | Machines usually use 4840, so a **different port such as 4841** is recommended |

- **This address is for others to connect to.** Entering it as the machine endpoint in collection would make the tool read its own served values — the tool blocks that
- **This port has no authentication.** It is separate from the HTTP token (chapter 12). Use it only inside the company network
- Everything is **read only.** Empty values are not an error (`BadWaitingForInitialData`)

---

## 9. File management

### File list — view, open, delete

Header **File ▾ → File list**.

![File list](images/manual/en/m31-files.png)

- Click a name to open it. "← viewing" marks the file you have open
- Delete one with **"Delete"** at the end of its row; for several, tick the **checkboxes** in front of the names → **"Delete N selected"** at the bottom ("Select all" is there too)
- **Deletion cannot be undone.** The copy stored on the server is gone (`.aasx` files you downloaded remain)
- If a **group points to the machine you are deleting, you are told first** — a group only points to the machine by one address, so a broken link looks fine at first sight. Deleting a group together with its machine gives no warning

### Continue working

The server keeps your uploaded files, and edits are saved to the server as you go. Close and reopen the browser and everything is still there —
pick the file in the header drop-down or in "Continue working" on the start screen. **Do not upload it again with "Open AASX" from your PC** (copies pile up).

### Where files are stored

| Started with | Storage | Kept? |
|---|---|---|
| `node apps/api/dist/server.js` | Memory | No — gone when the server stops |
| `AAS_DATA_DIR=<folder> …` | Files in that folder | Yes — copy the folder and it moves as is |
| Docker (`docker compose`) | PostgreSQL (`pgdata` volume) | Yes — unless you run `down -v` |

Different stores are different lists — the files on this PC and on the company server are not the same list.
There is no feature to move many files as one package — download files one by one, or move the store (folder, volume) as a whole.

---

## 10. Rules and the validation report

### "Rules and conventions" — on what grounds does the tool say "pass"

Header right **Settings ▾ → Rules and conventions** shows what the tool enforces **exactly as it currently runs** (it is drawn from the server, so if documents and code disagree, this screen shows it first).

![Rules screen](images/manual/en/m32-rules.png)

| Section | Contents |
|---|---|
| **Who decides acceptance** | **Not this tool.** The KOSMO Validator and aas-test-engines decide |
| **Conventions** | Own IRI root · required submodels · how ids are formed · asset kind (Type) · value sync policy |
| **Rule conflicts** | Where the KTL guideline and KOSMO collide, **what is currently chosen** |
| **43 rules** | id · layer (L1, L2, L3) · content · source document · whether it is auto-fixable |

### When rules conflict — choose by policy

| Policy | Default | If changed |
|---|---|---|
| `iriConflict` | KOSMO first | Keep official IDTA IRIs and only warn |
| `smlChildIdShort` | Warning | `forbid` makes it an error — when loading into BaSyx or passing the standard validator is the goal |
| `standardTemplateSemantics` | KOSMO first | `preserve` excludes IDTA and W3C standard terms from fixes (when you added standard templates such as AID) |

| How | |
|---|---|
| Once | `…/lint?smlChildIdShort=forbid` — only that request is judged differently |
| Whole server | Environment variable `LINT_STANDARD_TERMS=preserve` |
| Change values without redeploying | **Policy file** `AAS_POLICY_FILE=/etc/aas/policy.json` — `{"smlChildIdShort":"forbid","submodelCountRange":[6,9]}`. **With an invalid value the server does not start** (better than silently ignoring it). The rules screen shows the items overridden by the policy file at the top |

Precedence: **query parameter > environment variable > policy file > default**. If the check **logic** itself changes (a new KOSMO finding), that is a code change — after changing the rules, regenerate [rules.md](rules.md) with `node scripts/make-rule-list.mjs`.

> **Why is AASd-120 a warning** — it is in the specification, but the KOSMO Validator does not check it. `aas-test-engines`, however, treats it as an error,
> and `basyx-python-sdk` **silently drops the elements.** For submission only you can leave it, but if you plan to load into BaSyx, remove them with "Auto-fix" (it removes them by default).

---

## 11. Document assets

Header **Export ▾ → Document assets** — extracts the figures and tables for the **guidance** document of the submission (rule §13: a UML diagram for every submodel).

![Document assets](images/manual/en/m33-docs.png)

| To do this | How |
|---|---|
| One figure | Target (overall structure / one submodel) → **"Copy diagram"** → Ctrl+V into Word or Hangul. As a file: "Download PNG" |
| One table | Pick a submodel; the table below the figure → **"Copy table"** (pastes as a table) or "Download CSV" |
| Everything | **"Download the full document (.docx)"** — figures and tables of all submodels in one file. A4, 2 cm margins, continuous figure and table numbers |

- For Hangul (HWP) and Word, **"Copy diagram" (PNG)** is the safe choice. Figures have a white background
- Tables use the IDTA table format of real submission guidance documents. Tables are made **only for submodels that contain machine-specific elements (own IRIs)**; for standard template submodels you get the information to write and "To be filled in by a person" places instead
- The tool **does not write prose.** It extracts only facts from the file and does not edit your documents — this is material for pasting

---

## 12. Sharing on the company network — accounts and API keys

There are **two** ways in. People **sign in with an account**; machines (scripts, MES, BaSyx integration)
use an **API key**. Both can be on at the same time and do not block each other.

### 12-1. Accounts (people)

Needed only once.

1. Start the server and open it in the browser
2. If there are no accounts yet, the **"Create the first administrator"** screen appears
   (if you do not see a sign-in screen, use **Settings ▾ → Create the first administrator**)
3. Choose a login name and a password (**at least 10 characters**)
4. From then on, add people in **Settings ▾ → Manage accounts**

| Role | Can do |
|---|---|
| Administrator (admin) | Everything + create, lock accounts and reset passwords |
| Editor | Open, edit and export files |
| Viewer | View only — edits give 403 |

> **Setup code.** If the server is reachable **from other people's machines**, creating the first administrator
> asks for a setup code. It is printed where the server was started (startup log).
> Without it, **anyone on the same network could click first and become administrator**, and the person in charge
> would be stuck with "Accounts already exist". To set the value in advance, use `AAS_SETUP_CODE=<value>`.
> A server open only on your own PC (single user) does not ask.

- Only password **hashes** are stored (the plain password is kept nowhere)
- After 5 wrong attempts, the account rests for 5 minutes — this slows down password guessing
- Sign-in expires after 8 hours of inactivity (7 days at most)
- Changing someone's role or locking their account **ends their sign-in immediately**
- **Once any account exists, direct API calls also** need a sign-in (cookie) or an API key.
  Versions before 2026-10-06 let a server without an API key be read and deleted through the API without signing in (fixed).
  If scripts or company systems call this server, set `AAS_TOKEN` and call it with an API key (12-2)
- The change history records **who changed what** (chapter 5, "History")

#### After a server restart

| | Kept? | Notes |
|---|---|---|
| Accounts, passwords, roles | **Kept** | Folder store: `users.json`; Docker: the database |
| Uploaded files, edits, history | **Kept** | |
| Sign-in state | **Lost** | Held in server memory only — sign in again |
| The ↶ undo list on screen | Emptied | You can still restore a version from history (chapter 5) |

> **Note:** before 2026-10-06 the **folder store** (`AAS_DATA_DIR`) did not save accounts to a file,
> so a restart removed them and brought back "Create the first administrator". This is fixed — accounts created in
> those versions were not kept, so create them once more.

#### Sign-up is closed by default

On a company server not everyone should be able to create an account, so the sign-in screen shows **a note to ask your
administrator instead of "Sign up"**. Administrators add people in **Settings ▾ → Manage accounts**.

| For this kind of server | Setting |
|---|---|
| Company team server (default) | Nothing — the administrator creates accounts |
| Open sign-up for anyone | `AAS_SIGNUP=on` (+ `AAS_WORKSPACE=private` recommended — people do not see each other's files) |
| Public trial server | `DEMO_MODE=on` — sign-up opens automatically ([deployment.md](deployment.md)) |

New sign-ups become **editors** (viewers with `AAS_SIGNUP_ROLE=viewer`). Nobody can sign up as administrator —
otherwise the sign-up button would hand out admin rights. Promoting to administrator is done by an administrator.

#### Shared or separate — workspaces

| | Default (team shared) | `AAS_WORKSPACE=private` |
|---|---|---|
| Files you see | **Everyone sees the same files** | Each person sees **only what they uploaded** |
| Other people's files | Visible; editable depending on role | As if they did not exist (404 even with the address) |
| Administrators · API keys | Everything | **Everything** — operations and machine integration handle all files |
| Templates loaded at startup | Everyone reads and edits | Everyone reads only (source for imports) |

Usually a team edits the same equipment files together, so the default is shared. Separate them only when strangers
use the same server. **Note:** files uploaded **before** you turn separation on have no owner and
appear read-only to everyone — an administrator has to sort them out.

### 12-2. API keys (machines)

For callers that are not people — scripts, company systems, Part 2 REST integration.

```bash
AAS_TOKEN=edit-key AAS_READONLY_TOKEN=review-key node apps/api/dist/server.js   # Docker: in .env
```

```bash
curl -H "Authorization: Bearer edit-key" http://server:8080/packages
```

| | |
|---|---|
| Is it on? | `curl localhost:8080/health` → `{"auth":"on"}` |
| Read-only key | View only. Edits give 403 |
| Neither keys nor accounts | The server opens **only on that PC** by itself (a safety measure). To open it to the company network: `AAS_ALLOW_OPEN=1` |

Keys consist of letters, digits and symbols and are accepted only in the `Authorization: Bearer` header.

### 12-3. Put HTTPS in front

**Signing in over plain http sends the password and the sign-in cookie in the clear.** Anyone on the same
network can pick them up. Even on a company network, add HTTPS once people sign in.

Caddy is the easiest (it obtains and renews certificates by itself).

```caddyfile
# Caddyfile — in front of AAS running on port 8080 on the same server
aas.your-company-domain {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
caddy run --config Caddyfile
```

- If an internal domain cannot get a public certificate, write `tls internal` (self-signed)
  and install Caddy's root certificate once on the company PCs
- The program looks at `X-Forwarded-Proto` and adds `Secure` to the cookie and sends HSTS **only over HTTPS**.
  A plain-http server sending HSTS would lock that address into https-only in the browser for good
- Behind a proxy it is safest to bind the API to `127.0.0.1` only (`AAS_HOST=127.0.0.1`)

### 12-4. Started with no settings it is "single user"

A server without accounts or API keys opens only on your own PC (127.0.0.1). There is no sign-in screen, and the
"who" in the change history stays empty — on a single-user setup there is nobody to ask.
For several users, run it on a server with Docker (chapter 1).

---

## 13. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The page loads but the file list is empty / "Cannot reach the API server — check that port 8080 is running …" | The API is not running. Run `npm run dev:api` first |
| `Unexpected token '<'…` on the start screen | The development server (5173) is not forwarding an API path — `API_PATHS` in `apps/web/vite.config.ts`. Does not happen with the single-port build |
| The company server address does not open | Docker Desktop on that PC has stopped. Start it, then `docker compose up -d`. The data (pgdata) is intact |
| 400 on upload | Not an AASX, or a broken ZIP |
| 413 | The file exceeds the limit. `AASX_MAX_TOTAL_MB` |
| "This submodel was changed elsewhere first" | Someone else saved first. "Reload" |
| Files disappeared after stopping the server | Storage was in memory (chapter 9). Use `AAS_DATA_DIR` or Docker |
| The New form disappears | A defect where the form vanished while a file was uploading on the start screen was fixed on 2026-09-09. Check that you run the latest version |
| "Collect" returns 501 | The server was not started with `COLLECT=on` |
| "Load from equipment" is blocked because the address belongs to this authoring tool | You entered the serving address. Enter the machine (PLC) address |
| Collection says "Connection failed" | Address or firewall. When testing with the virtual PLC, check that `node scripts/plc-simulator.mjs` is running |
| No "→ Serving" chip | `OPCUA_SERVER=on` is not set |
| Other PCs cannot connect over OPC UA | Set this machine's IP in `OPCUA_HOST` and open that port in the firewall |
| "An access token is required." / it asks again after entering one | The server has authentication on / the token must match character for character |
| No sign-in screen | The server has neither accounts nor API keys — anyone can get in. Start with **Settings ▾ → Create the first administrator** (12-1) |
| "A setup code is required" | The server is reachable from outside, so it guards the first administrator. Enter the `First administrator setup code` from the server startup log |
| "Accounts already exist" but I have none | Someone created one first. Get an account from them, or turn on the setup code, empty the store and start again |
| "Requests sent from another site are not accepted" | Open the server directly from the **browser address bar**, not from a bookmark or link |
| Sign-in keeps expiring | It expires after 8 hours of inactivity (7 days at most). A server restart also ends it — sign-in data is held in server memory |
| "Too many sign-in attempts. Try again in 5 minutes." | After 5 wrong attempts sign-in pauses to slow down password guessing. Wait 5 minutes |
| `docker compose up` reports a password error | `POSTGRES_PASSWORD` in `.env` is empty |
| Port 8080 is already in use | `APP_PORT` in `.env` |
| The English UI shows some Korean | Names and values from your files and the submission bundle folder names are not translated (chapter 3, "Language and theme"). Any other Korean text on screen is a defect — please report it |
| Input disappeared after changing the language | Changing the language reloads the page. Save first, then switch |
| It opens in English but I want Korean | Your browser language is not Korean. **Settings ▾ → Language → 한국어** |

---

## 14. Known limits

- **Authentication applies only when turned on.** Started without settings, anyone who knows the address can read and delete (chapter 12).
  If you expose a server without accounts, **anyone could become the first administrator**, which the setup code prevents (12-1)
- **The OPC UA serving port has no authentication** (section 8-6). Company network only
- XML can only be read. Files are always saved as JSON
- The undo list lasts only while the server runs. History is kept
- Undo **does not distinguish between people** — with several users, someone else's change can be undone too.
  **Who made the change is recorded**, though (on servers with sign-in): names appear in history and in the undo list
- Operation elements are not supported
- The final acceptance decision is made by the **KOSMO Validator.** This tool filters before submission

---

## Appendix A. Common findings and what to do

| Rule | Meaning | What to do |
|---|---|---|
| `KOSMO-SME-3` | semanticId missing, or no matching CD | "Auto-fix" creates them per the conventions. **The most common finding** |
| `KOSMO-SM-2` / `AAS-3` | The last two digits of the id differ from `administration` | "Auto-fix" (references are updated too) |
| `KOSMO-SM-3` | semanticId outside the allow-list (usually an official IDTA IRI) | "Auto-fix" moves it to an own id and keeps the original in the relocation ledger |
| `KOSMO-AAS-1` | No thumbnail | "Auto-fix" |
| `KOSMO-AAS-4` | Number of submodels outside 6–8 | Add or remove to fit |
| `KOSMO-AAS-6` / `SM-4` | Not `assetKind=Type` / not `kind=Template` | "Auto-fix" |
| `KOSMO-SME-4` | Property value is empty | **A person enters it** (example data) |
| `KOSMO-CD-3` | No English definition | **A person enters it** (quote the development plan, do not invent) — 4-7 |
| `KOSMO-CD-5` (info) | A CD with the same idShort exists in two standard dictionaries | Do not change it — this is just a fact |
| `AASd-120` (warning) | A list child has an idShort | "Auto-fix" removes them. BaSyx and the standard validator reject these |
| `HIER-1·2·3` | A broken link in a group file | 7-6 |

## Appendix B. Glossary

| Term | Meaning |
|---|---|
| **AAS** (AssetAdministrationShell) | The digital shell of one asset (machine, process). One file (.aasx) = one AAS |
| **AssetInformation** | Which asset this AAS describes — `assetKind` (Type/Instance) · `globalAssetId` (address) · thumbnail |
| **Submodel** | A chapter of content — nameplate (DigitalNameplate) · technical data (TechnicalData) · documentation (HandoverDocumentation) … |
| **SMC / SML** | SubmodelElementCollection (group addressed by name) / SubmodelElementList (list addressed by position) |
| **Property · MLP · Range · File** | One value · text per language · min–max · attached file |
| **idShort** | The element's name (Latin letters). Must be unique at its level |
| **semanticId** | The address that says "what this element means" — a standard dictionary (IRDI, `0173-1#02-…`) or an own IRI |
| **ConceptDescription (CD)** | The definition the semanticId points to (English definition, data type, unit) |
| **HierarchicalStructures** | The standard submodel for structure (BoM, process structure) (IDTA 02011). Parts for a machine, processes and machines for a company |
| **AID** (AssetInterfacesDescription) | The standard submodel that says where to connect and what to read (IDTA 02017) — the collection link |
| **Type / Instance** | Type (catalog) / instance (one machine with a serial number). Deliverables of this program are **Type** |
| **KOSMO Validator** | The validator of the Korean submission program — **the authority on acceptance.** This tool's linter filters before it |
| **KTL** | Korea Testing Laboratory; its guideline is the rulebook that sometimes conflicts with KOSMO (10, "Rule conflicts") |
