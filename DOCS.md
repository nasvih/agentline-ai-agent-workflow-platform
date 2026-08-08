# Agentline — technical notes

## What this is

Agentline is a workspace for putting agents to work. You define an agent, give it the tools it is
allowed to use and the guardrails it has to obey, then run it on its own or as a step inside a
workflow. Every run is written down as a trace you can open afterwards and read line by line.

## Where it helps a business

- Repetitive desk work — triaging a ticket queue, reading invoices, drafting the weekly report —
  gets a first pass before anyone opens it.
- Every run leaves a trace, so an answer can be explained: which tool was called, on what, and what
  came back.
- Guardrails are configuration, not code. Redaction, allowed topics, escalation to a human and a
  cost ceiling are set by whoever owns the process.
- Connections are explicit. An agent cannot touch a system nobody granted it.
- When something goes wrong, the run history shows which step failed and why, instead of one blank
  error.

## How it would work for real

The same interface, with a real model provider behind the agents, real connections to the systems
named on **Tools**, and the run history in a database rather than this browser. This demo simulates
only that model layer, so the product itself can be judged: the interface, the traces, the guardrail
behaviour and the shape of a workflow are real design decisions. The answers are not model output.

The seam is narrow on purpose. `wrapIntent` in `src/agent.js` is where a real completion call would
go, `planRun` in `src/views/workflows.js` is where a real orchestrator would go, and the run records
written into `state.runs` are already shaped like rows in a traces table.

## How this demo works

**You can actually use it.** Build workflows, add and remove steps, run them, toggle tools and
guardrails, create agents, talk to them. Nothing here is read-only and nothing is a screenshot.

**Your data stays on your machine.** Everything you enter is saved in this browser's local storage.
There is no account and no backend. Clear your browser data, or use **Reset demo data**, and it is
all gone. It does not sync between browsers or devices.

**The agents are simulated.** Every reply, tool call, token count and latency figure is generated
locally from this app's demo data. No model is connected and no request leaves your browser.

The same four blocks are the body of the **About this demo** modal in `src/main.js`.

---

## Architecture

Plain ES modules loaded straight from the page. No bundler, no framework, no dependencies and no
build step. The application code contains no `fetch` call at all — the only one in the repository is
in `sw.js`, which re-requests this app's own files to fill the offline cache.

```
index.html
   ├── manifest.webmanifest         installable app metadata
   └── src/main.js                  store · nav · router · shell · console agent
          ├── lib/pwa.js            service worker registration + install control
          │      └── sw.js          offline shell cache (registered at the app root)
          ├── src/data.js           seed + lookups (imported by everything)
          ├── src/agent.js          intent packs + guardrail engine
          ├── src/selftest.js       suggestion routing check
          └── src/views/*.js        render(ctx) -> Node, one module per screen
```

`main.js` owns the only router. Each view module exports a single `render(ctx)` that returns a
detached DOM node; `main.js` clears `#view` and appends it. Views never re-render themselves
implicitly — a view that changes state calls `ctx.refresh()` when it wants the screen redrawn. That
keeps the Playground chat alive while a run is being written to the store behind it.

### The render context

```js
ctx = {
  store,                    // createStore handle
  state,                    // getter -> store.state
  navigate(path),           // sets location.hash
  route, params, query,     // '#/runs/run_abc?status=failed' -> 'runs', ['run_abc'], URLSearchParams
  refresh(),                // redraw the current screen
}
```

### State

One `localStorage` key, `agentline.demo.v1`, written by `createStore` on every update. The seed
lives in `src/data.js` and is produced by `seeded(20260808)`, so a fresh workspace is identical on
every machine. **Reset demo data** (sidebar footer, top bar, Settings) calls `store.reset()`.

## Data model

```
state
├── settings      workspace, environment, defaultModel, streaming, retentionDays,
│                 region, traceSampling, notifyOn, distribution
├── tools[]       id, name, icon, kind, account, ops[], description,
│                 connected, calls30d, latencyMs, connectedAt
├── guardrails[]  id, name, kind (redact|topics|escalate|cost), enabled, summary, detail
│                 + per kind: masks[] | topics[] blocked[] | queue triggers[] | limitPaise
├── agents[]      id, name, initials, status (live|paused|draft), purpose, description,
│                 model, owner, tools[], guardrails[], successRate, runs30d,
│                 avgLatencyMs, avgTokens{in,out}, createdAt, custom?
├── workflows[]   id, name, enabled, description, trigger{kind,label,detail},
│                 steps[]{id,name,kind,ref,detail,avgMs,enabled}, outputs[], runs30d, lastRunAt
├── runs[]        id, agentId, workflowId, trigger, status, startedAt, durationMs,
│                 tokensIn, tokensOut, costPaise, question?, guardrails[]{id,verdict},
│                 trace[]{label,kind,status,ms,detail}
├── tickets[]     the support queue the triage agent reads
├── invoices[]    the supplier invoices the extraction agent reads
├── accounts[]    the onboarding book
├── metrics[]     eight weeks of run volume, success, escalations, tokens, cost
└── counters      runSeq, agentSeq, escalationSeq
```

`status` on a run is one of `success`, `failed`, `escalated`, `blocked`. Step status inside a trace
uses `ok` instead of `success`, plus `skipped`, `redacted`, `failed`, `blocked`, `escalated`.

Cost is held in paise as an integer and rendered by `rupees()`. The demo token rate is
`TOKEN_RATE = { in: 0.012, out: 0.045 }` paise per token.

## Module map

| File | Responsibility |
|---|---|
| `src/main.js` | Store creation, nav definition, hash router, sidebar and mobile menu, rail and colour toggles, the install control, About and shortcut modals, reset, the global console agent, go-to key handling. |
| `lib/pwa.js` | Service worker registration and the **Install app** control (copied from the kit, unmodified). |
| `sw.js` | Offline shell cache. Its `SHELL` array lists every file this app needs to boot. |
| `src/data.js` | `seedState()` and every lookup helper (`agentById`, `toolById`, `guardById`, `workflowById`, `guardActive`, `estimateCost`, `rupees`, `newRunId`), plus `MODELS` and the status-to-pill maps. |
| `src/agent.js` | `wrapIntent` (the guardrail engine), the four packs, the shared intents, `packFor`, `buildAgentBot`, `buildConsoleBot`, `redactText`, `CONSOLE_SUGGESTIONS`, `AGENT_SUGGESTIONS`, `GUARDRAIL_PROBES`. |
| `src/selftest.js` | Routes every suggestion chip and guardrail probe through `Assistant._route` and asserts none reaches the fallback. |
| `src/views/agents.js` | Card grid, detail drawer, create/edit modal, pause/activate, delete. |
| `src/views/playground.js` | Agent picker, `Assistant.mountInto`, the run inspector rail, guardrail probes. |
| `src/views/workflows.js` | Workflow list, node editor, `planRun`, the streaming run log, add-step modal. |
| `src/views/runs.js` | Filtered history table, CSV export, run detail with trace timeline, re-run. |
| `src/views/tools.js` | Connection cards, disconnect confirmation, agent × tool matrix. |
| `src/views/guardrails.js` | Rule cards, per-kind configuration editors, live redaction preview, guardrail event log. |
| `src/views/settings.js` | Workspace form, workspace summary, agent CSV export, danger zone. |

## Intent packs

An intent is a plain object:

```js
{
  id: 'queue',
  match: [/queue|backlog|open tickets/i, 'inbox'],   // regex = 2 points, string = 1
  tools: ['ticketing'],                              // must be connected or the turn fails
  trace: 'scanned the inbound queue',                // shown under the reply
  answer: (q, { state, agent }) => ({ text, table, suggestions }),
}
```

`Assistant._route` scores every intent against the question and takes the highest. `answer` always
reads `state`, never a snapshot, so a reply changes the moment you change the data.

Each agent's pack is its own function in `src/agent.js`:

| Agent | Pack | Unique intents |
|---|---|---|
| **Support Triage** | `triagePack()` | queue size and oldest items · a named ticket with its CRM record · priority breakdown · routing by desk load · a drafted reply · complaint themes by category · first-reply SLA and breaches · the customer with the most open contact |
| **Invoice Reader** | `invoicePack()` | field extraction for a named invoice · the low-confidence review pile · payable totals posted vs held · value by vendor · tax recomputed per band · duplicate detection · purchase-order variance · what has been appended to the workbook |
| **Onboarding Assistant** | `onboardPack()` | the six-step checklist with a head count per step · accounts stuck five days or more · a single account's progress · product how-to answers from a small note base · booking a call with the account owner · a drafted nudge mail · time to first value by plan · accounts by region |
| **Report Writer** | `reportPack()` | the written weekly summary · week-on-week comparison · eight weeks of volume · anomalies over ten per cent · an executive paragraph · the distribution list · data source and freshness · what its failure mode actually is |
| *anything you create* | `genericPack()` | workspace overview · its own run history · what it can be asked |

Every agent also gets `sharedIntents()`: what it is, its own run statistics, its tools, its
guardrails, its cost, and a contact lookup (which exists mainly so the redaction rule has something
to redact).

Two **catcher intents** are appended last, to every agent, so they only win when nothing else does.
Both use a `match` **getter** rather than a fixed array, so they always reflect the guardrail
configuration as it stands right now:

- `offTopicIntent` matches the current blocked-term list. Without it, an off-topic question that
  matched no ordinary intent would slip past the topic check into the fallback line.
- `handoverIntent` matches the current escalation trigger words, so "the customer wants a refund"
  lands somewhere sensible even on an agent the escalation rule is not bound to.

The workspace-wide **Agentline Console** (`buildConsoleBot`) has twelve of its own: health,
failures, escalations, cost, busiest agent, connections, guardrails, workflows, latency, a named
agent, recent activity, and how the demo works.

### Suggestion chips must always route

A chip the assistant cannot answer is the worst first impression the product can make, and it is the
first thing anyone clicks. So every string that can ever appear as a chip has one source of truth —
`CONSOLE_SUGGESTIONS`, `AGENT_SUGGESTIONS`, `DEFAULT_AGENT_SUGGESTIONS` and `GUARDRAIL_PROBES` — and
none of them may reach the fallback.

Two rules keep that true. Intents never override `suggestions` on a blocked, escalated or
tool-gated reply, so the chips fall through to the bot's configured list rather than disappearing.
And `src/selftest.js` checks the whole set:

```js
await agentline.selfTest()
// -> { tested, passed, failed, agents, results, failures }
```

It routes each question through `Assistant._route` without composing an answer or writing a run, so
it is safe to run at any time, and it covers the console, every agent in the current state
(including agents you created in the UI, which use the generic pack) and all three guardrail probes
against each of them. Failures are logged with the source and the question. Current state:
**32 routed for the seeded workspace, 39 with a fifth agent added, zero failures.**

## The guardrail engine

`wrapIntent(intent, agent, store, emit)` wraps every intent's `answer` in a pipeline. Order matters
and is fixed:

1. **Allowed topics** — if the rule is on for this agent and the question contains a blocked term,
   the turn is refused before a single record is read. Status `blocked`.
2. **Escalation to human** — if the question contains a trigger word and the rule is on, the agent
   writes a handover note, raises an `ESC-` reference in the configured queue and stops. Status
   `escalated`. With the rule off it answers and appends a line saying it did so without a handover.
3. **Tool gate** — every tool listed on the intent must be connected. A disconnected tool produces a
   refusal naming the tool and what remains possible without it. Status `failed`.
4. **The intent itself** — the only stage that reads business records.
5. **PII redaction** — `redactText` masks email addresses, phone numbers and long account numbers in
   the reply text *and* in every table cell. Verdict `redacted` with a count, or `passed`.
6. **Cost ceiling** — tokens are estimated from question length, answer length and the number of
   tool calls; if the run costs more than the limit the answer is truncated to its first paragraph
   with the reason attached. Status `blocked`.

Everything the pipeline observed becomes a telemetry object, handed to `emit` (the Playground rail
replays it as a timeline) and written into `state.runs` after the reply finishes streaming — which
is why a Playground turn shows up in the Runs screen with a full trace.

### Seeing each rule change the output

Open the Playground and use the three probe buttons, or type these:

| Question | Rule on | Rule off |
|---|---|---|
| `who do I contact about the oldest open item?` | `ra•••@•••.example · +91 90••••••` | `rahul@riyadhfitout.example · +91 90517474` |
| `what are the salary bands here?` | refused, with the topic list quoted back | answered as "no records on that", explicitly not a refusal |
| `the customer is angry and wants a refund` | handover to *Tier 2 · Kochi desk* with a reference | answered directly, with a line saying nobody was looped in |
| any question, ceiling set to ₹0.20 | truncated at the first paragraph with the estimate and the cap | full answer plus table |

Disconnect **Ticketing** in Tools & connections and ask Support Triage `how big is the queue?` — the
refusal names the connection, and the inspector records the failed tool call.

## Adding an agent

**In the UI** — Agents → New agent. Pick a name, a model, its tools and its guardrails. It gets
`genericPack()`, so it can talk about itself, its runs, its tools and its guardrails immediately,
and it appears in the Playground picker, the Runs filter and the workflow step editor.

**In code**, to give it real work:

1. Add the record to `seedAgents()` in `src/data.js` — `id`, `initials`, `purpose`, `description`,
   `model`, `tools`, `guardrails` and the headline numbers.
2. Write `myPack()` in `src/agent.js` returning six to eight intents. Declare `tools: [...]` on any
   intent that should be gated by a connection, and read `state` inside `answer` rather than
   capturing values.
3. Register it: `PACK_BUILDERS.myAgent = myPack`.
4. Add four starter questions to `AGENT_SUGGESTIONS.myAgent`.

Nothing else needs touching — the picker, the runs, the guardrail bindings and the workflow step
editor all read the agent list.

Adding a **tool** is `seedTools()` plus an `icon` name from `ICONS`; adding a **guardrail** means a
new `kind` in `seedGuardrails()`, a stage in `wrapIntent` and a branch in `config()` in
`src/views/guardrails.js`.

## Keyboard

| Keys | Action |
|---|---|
| <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd> | Open or close the Agentline Console |
| <kbd>Esc</kbd> | Close the console, a modal, a drawer or the mobile navigation |
| <kbd>g</kbd> <kbd>a</kbd> | Agents |
| <kbd>g</kbd> <kbd>p</kbd> | Playground |
| <kbd>g</kbd> <kbd>w</kbd> | Workflows |
| <kbd>g</kbd> <kbd>r</kbd> | Runs |
| <kbd>g</kbd> <kbd>t</kbd> | Tools and connections |
| <kbd>g</kbd> <kbd>d</kbd> | Guardrails |
| <kbd>g</kbd> <kbd>s</kbd> | Settings |
| <kbd>?</kbd> | Shortcut list |

Go-to keys are ignored while a field has focus.

## Design tokens

From `assets/app.css`, unchanged. `assets/agentline.css` adds components only and uses these
variables — it defines no new colours.

| Token | Value | Use |
|---|---|---|
| `--bg` `--surface` | `#FFFFFF` | page and card ground |
| `--surface-2` | `#FAFAF8` | table heads, inset panels, the assistant log |
| `--hover` | `#FEFBEA` | row and control hover |
| `--ink` `--ink-2` `--muted` `--faint` | `#17181A` `#2E3033` `#5A5F66` `#686E75` | text ramp |
| `--line` `--line-2` | `#E7E7E4` `#D8D8D3` | hairlines and control borders |
| `--amber` `--amber-fill` | `#EAC81C` | the one accent, always a **fill** with ink text |
| `--amber-deep` | `#8A6D00` | amber-coloured *text* on white — never `#EAC81C` on white |
| `--amber-soft` `--amber-line` | `#FEF9DA` `#F0DE8C` | active nav, trigger node, demo notes |
| `--night` | `#17181A` | the run log panel and dark buttons |
| `--ok` `--warn` `--bad` `--info` | `#1E7A4B` `#9A6400` `#B3261E` `#1F5C9E` | status, always paired with a word |
| `--r-lg` `--r` `--r-sm` `--r-xs` | 12 / 8 / 6 / 4 px | radii |
| `--sans` `--mono` | Inter / JetBrains Mono | UI text / labels, numbers, ids, code |

Rules kept throughout: solid colours only — no gradients, no blur, no glow shadows, no emoji.
Icons are inline stroke SVG from `ICONS` using `currentColor`. Status is never signalled by colour
alone; a pill always carries the word.

## Shell controls

Two sidebar-footer buttons, both `aria-pressed` and both persisted under `agentline.ui.v1`
(separate from the workspace data, so **Reset demo data** does not undo them):

- **Collapse / Expand** toggles `is-rail` on `.shell` — a 64px icon rail with labels, counts and
  group headings hidden. Nav links pick up `title` and `aria-label` in rail mode. The nav icon is a
  direct child of the link rather than being wrapped in a span, because rail mode hides every span
  inside a `.navlink` and the glyph has to survive that.
- **Yellow / White** toggles `data-tone="amber"` on `.side`. **Yellow is the default** — the
  preference object starts `{ rail: false, amber: true }` and the stored object is spread over it,
  so a browser with nothing saved renders the yellow navigation. The button label names the action,
  not the state, so it reads `White` while yellow is on; `aria-pressed` carries the state. Ink text
  on `#EAC81C` throughout — never white on yellow. The pressed toggle uses an ink *outline* rather
  than an ink fill, so the link out to nasvih.in stays the only solid dark block in the footer.

Below them, `#sidefoot` holds the install control (see below), **Reset demo data**, **About this
demo**, a dark `.side__site` link out to nasvih.in (`target="_blank"`, `rel="noopener noreferrer"`,
`aria-label` saying it opens in a new tab) and **Keyboard shortcuts**. Everything in the footer is a
`.btn`, so it collapses to its glyph in rail mode with the label kept in `title`/`aria-label`.

Under 900px the sidebar is a drawer, and `.shell.is-rail` would otherwise out-specify the
responsive rule and claim a 64px grid column. `assets/agentline.css` overrides the rail inside the
900px media query so the drawer keeps its full width and its labels regardless of the setting.

## Installable app

Agentline is a progressive web app. Three pieces:

| File | Role |
|---|---|
| `manifest.webmanifest` | `Agentline`, `start_url` and `scope` both `./` so it works from a GitHub Pages subdirectory, `display: standalone`, `background_color: #FFFFFF`, `theme_color: #EAC81C`, three icons (192 any, 512 any, 512 maskable), `lang: en`. |
| `sw.js` | Registered at the app root so its scope covers the whole app. `install` pre-caches an explicit `SHELL` array — every HTML, CSS, JS module, the manifest and the icons — into one versioned cache; `activate` deletes any older cache under the same scope; `fetch` is cache-first for same-origin, shell-fallback for navigations, network-first for the font stylesheet. |
| `lib/pwa.js` | Copied from the kit. Registers the worker, captures `beforeinstallprompt`, and renders the **Install app** control, hidden until the browser says installing is possible. iOS has no prompt event, so there the control explains Share → Add to Home Screen. |

`main.js` calls it once at boot and routes its messages through the app's toast:

```js
const pwaSlot = h('div', { class: 'side__install' });
initPWA({ mount: pwaSlot, appName: 'Agentline', onNote: (msg) => toast(msg) });
```

The control is mounted into its own element rather than straight into `#sidefoot` because
`paintFoot()` clears the footer on every sidebar repaint; the wrapper is re-appended, so the button
keeps the deferred prompt and its listeners.

**When you add or rename a file, add it to `SHELL` in `sw.js` and bump `CACHE_VERSION` in the same
file.** Otherwise the worker keeps serving the previous copy and the new file is missing offline.

### One chat affordance at a time

The console has a single entry point: the floating round launcher, plus
<kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd>. There is no topbar or sidebar duplicate. On the
Playground — a product screen with its own docked composer — the launcher is hidden by
`body.is-playground .assist-fab { display: none }`, which is used in preference to the assistant's
own `hidden` flag so that opening and closing the panel cannot bring it back. Navigating to the
Playground with the console open closes it. The keyboard shortcut still reaches the console from
anywhere.

## Accessibility and responsiveness

- Sidebar collapses under 900px behind a labelled menu button with `aria-expanded`, dismissed by
  <kbd>Esc</kbd> or the scrim.
- Layouts hold at 390px: the playground stacks under 1180px, the agent grid and workflow columns
  under 900px, and the inspector statistics go single column under 400px.
- Icon-only controls carry `aria-label` — step reorder and removal, switches, drawer close, the
  menu button, the assistant launcher, and both sidebar toggles in rail mode.
- The run log and the workflow status pill are `aria-live` regions.
- Focus is visible everywhere via the shared `:focus-visible` ring; `prefers-reduced-motion` stops
  the streaming and blip animations.

## Known limits

- Run history is capped at 90 entries, so a long session drops the oldest traces.
- Agents created in the UI share one generic pack — they will not answer domain questions until a
  pack is written for them in code.
- A workflow's steps are the only thing that can be edited; triggers and outputs are fixed per
  workflow.
- Nothing is validated as a schema. Editing state by hand in `localStorage` will break the screens
  until you reset.
