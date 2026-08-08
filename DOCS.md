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

**The agents do things, not only answer.** An answer may carry actions. The agent states what it
understood and what it would touch, and changes nothing until the reader presses the button; then it
applies the change, reports before → after, and writes a real run with a real trace.

**The agents are simulated.** Every reply, tool call, token count and latency figure is generated
locally from this app's demo data. No model is connected and no request leaves your browser.

Those blocks are the body of the **About this demo** modal in `src/main.js` — opened from the amber
button in the top bar, not from the sidebar — followed by the full action catalogue rendered from
`ACTION_PROBES`, and by **The source** carrying `REPO_URL` and the licence sentence.

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
          │      └── src/actions.js the intents that change the workspace
          │             └── src/runner.js  run engine · refresh bus · run writer
          ├── src/topbar.js         notifications · device preview · dark mode
          ├── src/selftest.js       chip + action routing check
          └── src/views/*.js        render(ctx) -> Node, one module per screen
```

`src/runner.js` is the only place a workflow is executed. Both the **Run workflow** button in
`views/workflows.js` and an agent told to run one call the same `executeWorkflow`, so the two can
never drift apart.

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
│                 + escalationRef and status 'escalated' once an agent hands one over
├── invoices[]    the supplier invoices the extraction agent reads
│                 + postedToSheet, approvalState, postedAt once an agent posts one
├── accounts[]    the onboarding book (stepIdx and stuckDays move when an agent advances one)
├── metrics[]     eight weeks of run volume, success, escalations, tokens, cost
├── reports[]     id, title, createdAt, agentId, body, metrics — written by the Report
│                 Writer when it is told to store a summary, listed under Settings
└── counters      runSeq, agentSeq, escalationSeq
```

`status` on a run is one of `success`, `failed`, `escalated`, `blocked`. Step status inside a trace
uses `ok` instead of `success`, plus `skipped`, `redacted`, `failed`, `blocked`, `escalated`.

Cost is held in paise as an integer and rendered by `rupees()`. The demo token rate is
`TOKEN_RATE = { in: 0.012, out: 0.045 }` paise per token.

## Module map

| File | Responsibility |
|---|---|
| `src/main.js` | Store creation, nav definition, hash router, sidebar and mobile menu, the brand-row rail and colour controls, the install control, About and shortcut modals, reset, the global console agent, go-to key handling. |
| `lib/pwa.js` | Service worker registration and the **Install app** control (copied from the kit, unmodified). |
| `sw.js` | Offline shell cache. Its `SHELL` array lists every file this app needs to boot. |
| `src/data.js` | `seedState()` and every lookup helper (`agentById`, `toolById`, `guardById`, `workflowById`, `guardActive`, `estimateCost`, `rupees`, `newRunId`), plus `MODELS` and the status-to-pill maps. |
| `src/agent.js` | `wrapIntent` (the guardrail engine), the four packs, the shared intents, `packFor`, `buildAgentBot`, `buildConsoleBot`, `redactText`, `CONSOLE_SUGGESTIONS`, `AGENT_SUGGESTIONS`, `GUARDRAIL_PROBES`, `ACTION_PROBES`, `SCOPE_LABEL`. |
| `src/actions.js` | Every intent that changes something: `consoleActions`, `agentActions`, `guardToggleIntent`, `toolConnIntent`, the four domain actions, and `ACTION_CATALOGUE` / `catalogueFor` — the single source of truth for what the agents claim they can do. |
| `src/runner.js` | `planRun` / `executeWorkflow` (the run engine), `requestWorkflowRun` / `consumeWorkflowRun` (the hand-off to the Workflows screen), `writeActionRun`, and the `onAppRefresh` / `refreshApp` bus. |
| `src/topbar.js` | The three top-bar controls: notifications (`buildNotes` derives them from live state), device preview (the phone `<iframe>`), and the dark-mode toggle. |
| `src/selftest.js` | Routes every suggestion chip, guardrail probe and action phrase through `Assistant._route`; action phrases must also land on the advertised intent and offer a runnable button. |
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

It routes each question through `Assistant._route` and, for action phrases only, composes the answer
as well — composing is read-only, because an action mutates the store inside `run()` and `run()` is
never called here. It covers the console, every agent in the current state (including agents you
created in the UI, which use the generic pack), all three guardrail probes against each of them, and
every phrase in `ACTION_CATALOGUE`. Failures are logged with the source and the question. Current
state: **52 checks for the seeded workspace — 20 chips, 12 probes, 20 action phrases — zero
failures.** Adding an agent in the UI adds four chips, three probes and two shared action phrases.

## Action intents

An ordinary intent answers. An action intent answers **and offers to change the workspace**. The
contract is enforced by `lib/assistant.js`:

```js
answer(q, ctx) -> { text, table?, actions: [{ label, doingLabel?, run }] }
run()          -> { text, table?, meta?, suggestions?, actions?, then? }
```

`_renderActions` draws the buttons in a `.msg__actions` row under the reply. Pressing one disables
the row, swaps the label for `doingLabel`, awaits `run()` — it may be async — removes the row so it
cannot be pressed twice, and appends the result as the next message. A result may carry its own
actions, which is how "run it" chains into "open the trace".

Three rules hold for every action in `src/actions.js`:

1. **Never mutate without a press.** `answer` only reads. Every write is inside `run()`.
2. **Name what will be touched.** The answer lists the exact records — workflow, step, ticket,
   invoice, connection, agent, rule — before the button exists.
3. **Report before → after.** The result is a two-column table of what moved, and the change is
   visible in Runs, Workflows, Guardrails, Tools or Agents immediately.

| Intent | Where | Touches |
|---|---|---|
| `wfrun` | console | Runs a named workflow through `requestWorkflowRun` |
| `wfstep` | console | Adds or removes a step on a named workflow |
| `toolconn` | console + every agent | `tools[].connected` |
| `agentstate` | console | `agents[].status` |
| `rerun` | console | Re-checks connections and writes a new run from a failed one |
| `guardtoggle` | console + every agent | `guardrails[].enabled`, then re-asks the previous question |
| `ticketaction` | Support Triage | Escalates (`ESC-` reference, `counters.escalationSeq`) or reassigns a ticket |
| `postinvoice` | Invoice Reader | Posts an invoice to Payables Q3 as *pending approval* |
| `advance` | Onboarding Assistant | Moves an account to the next checklist step |
| `genreport` | Report Writer | Writes and stores a weekly summary in `state.reports` |

### The refresh bus

An action mutates the store, then calls `refreshApp()` from `src/runner.js`. `main.js` subscribes
once:

```js
onAppRefresh(() => {
  topbar.refresh();                                   // notification count
  if (current === 'playground') { paintNav(); return; }  // never redraw the chat
  nav.go();                                           // re-read the hash, keep params
});
```

The Playground is deliberately excluded: redrawing it would rebuild the `Assistant` and throw away
the conversation the button was pressed in. Everything the action changed is still in the store, so
navigating to Guardrails or Runs shows it — no reload.

### Running a workflow from a conversation

An agent asked to run a workflow does not run it out of sight. `requestWorkflowRun` parks the
request, navigates to `#/workflows/<id>`, and that view picks it up with `consumeWorkflowRun` in a
`queueMicrotask` and streams the steps into its own run log. The promise resolves with the run
summary, which becomes the reply. If nothing claims the request within 1.6 s — no view mounted, for
instance — the run happens anyway with `pace: 0` and the app refreshes. There is no path where the
button reports a run that did not happen.

### Operator instructions and the guardrails

An action intent carries `operator: true`. `wrapIntent` then skips the topic and escalation checks
and records one `skipped` event explaining why: "escalate this ticket" is an instruction from the
person using the product, not customer text that should trip the escalation trigger. Redaction and
the cost ceiling still apply, and a turn that ends anything other than `success` has its `actions`
stripped — a refusal does not get to offer buttons.

### Re-asking the previous question

`buildAgentBot` creates a `session` object (`{ bot, lastQ }`), passes it into the pack and into
`wrapIntent`, which records `lastQ` for every non-operator turn. `guardtoggle` reads it, tells you
which question it is about to repeat, and after applying the change calls `session.bot.ask(prev)`
from the result's `then`. Ask *who do I contact about the oldest open item?*, then *turn off PII
redaction and ask that again*, and the masked and unmasked answers sit one above the other.

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

Two buttons on the sidebar brand row, in `.side__brandbtns` right of the app name, both
`aria-pressed` and both persisted under `agentline.ui.v1` (separate from the workspace data, so
**Reset demo data** does not undo them). Both are icon-only — the kit clips their `<span>` and
sizes them to 30×30 — so the glyph and the accessible name do all the work. They are created once
and `applyUI()` is the only thing that writes to them, so what a screen reader is told cannot drift
from what is on screen.

- **Collapse sidebar / Expand sidebar** toggles `is-rail` on `.shell` — a 64px icon rail with
  labels, counts and group headings hidden. Its `title` and `aria-label` name the action and follow
  the state, and the glyph is a panel whose chevron points at the edge the sidebar is about to move
  to. Nav links pick up `title` and `aria-label` in rail mode. The nav icon is a direct child of the
  link rather than being wrapped in a span, because rail mode hides every span inside a `.navlink`
  and the glyph has to survive that.
- **Sidebar colour** toggles `data-tone="amber"` on `.side`. It names no colour in the interface or
  in the accessible name: the glyph, a circle half filled, carries that, and `aria-pressed` reports
  whether the yellow tone is on. **Yellow is the default** — the preference object starts
  `{ rail: false, amber: true }` and the stored object is spread over it, so a browser with nothing
  saved renders the yellow navigation. Ink text on `#EAC81C` throughout — never white on yellow.
  A pressed control uses an ink *outline* rather than an ink fill, so the link out to nasvih.in
  stays the only solid dark block in the sidebar.

In the rail `.shell.is-rail .side__brandbtns` stacks the pair into a column under the mark, so both
stay reachable inside 64px.

`#sidefoot` below holds, in order: a `.side__pair` with the dark
`.side__site` link out to nasvih.in beside **GitHub** pointing at `REPO_URL`, then a
second `.side__pair` with the install control (see below) beside **Reset demo data**, then
**Keyboard shortcuts**. A pair is a flex row whose children share the width and truncate their
labels rather than overflow, and the kit stacks it back into a column in the rail. Both links are
built by the same `footLink()` helper, so both get `target="_blank"`, `rel="noopener noreferrer"`
and an `aria-label` ending "opens in a new tab". Only nasvih.in carries `.side__site`; the
repository link is an ordinary outline control, because one inverted element is the point of the
inverted element. Everything in the footer is a `.btn`, so it collapses to its glyph in rail mode
with the label kept in `title`/`aria-label`.

*About this demo* is **not** in the footer. It is the amber `#aboutbtn` pill in the top bar, where a
first-time reader looks for it, and it is the same `showAbout()` modal.

## Top bar controls

`src/topbar.js` mounts three icon-only controls into `#topbartools`, between the page title and the
About button. All three are `<button>`s with `aria-label` and `title`, and none of them is
colour-only.

### Notifications

`buildNotes(state)` derives the list from the store every time the panel opens — nothing is stored
except which ids have been read. Sources, in one pass over the data:

| Source | Id | Tone |
|---|---|---|
| Runs with status `failed` | `fail:<runId>` | bad |
| Runs with status `escalated`, and tickets an agent escalated | `esc:<runId>`, `tick:<ticketId>` | warn |
| Runs with a `blocked` guardrail verdict | `block:<runId>` | info |
| Runs whose `costPaise` exceeds the live ceiling | `cost:<runId>` | warn |
| Disconnected tools | `tool:<toolId>` | bad |

Ids are stable, which is what makes "read" stick. `prefs.readNotes` is pruned to ids that still
exist on every write, so it cannot grow forever. The badge shows the unread count (`9+` above nine)
and is hidden at zero. A row can be marked read on its own, all of them at once, or read implicitly
by clicking through to the run or screen behind it. With no sources at all the panel carries a
proper empty state rather than a blank box.

Two details worth keeping: the outside-click handler ignores events whose target is no longer
connected to the document, because marking one item read repaints the list under the pointer and
that is not an outside click; and **Reset demo data** clears `readNotes`, because the seed is
deterministic and the rebuilt runs carry the same ids.

### Device preview

A phone and a desktop icon, `aria-pressed` on both. Phone mode appends a `.devframe` overlay: the
app name, a "Back to desktop" button, and an `<iframe>` of `./index.html?frame=1<hash>` at
390 × 844 inside a dark bezel on an `--amber-fill` surround. It is an iframe rather than a scaled
screenshot so the real breakpoints apply. `fit()` scales the bezel with `transform` on resize and
sizes the slot to the scaled box, so the surround never scrolls sideways.

Two things keep the two copies from fighting:

- `main.js` hides `#shell` **and empties `#view`** on entry, so the Playground chat is never mounted
  twice; `render()` returns early while `phoneMode` is on, and leaving re-renders the current route.
- The framed copy sets `body.is-framed` from the `frame=1` query flag, and `initTopbar` does not
  mount the device control at all when `framed` is true.

Both copies share one origin and therefore one `localStorage`, so a change made inside the frame is
a change to the workspace.

### Dark mode

`data-theme="dark"` on `<html>`, persisted in `agentline.ui.v1` as `theme`. With nothing stored the
app follows `prefers-color-scheme` and keeps following it — the media listener only applies while
the reader has made no explicit choice. A small inline script in `index.html` sets the attribute
before first paint from the same key and the same rule, so a dark reader never gets a white flash.
The button swaps between a moon and a sun and updates `theme-color`.

The palette is the kit's (`assets/app.css`, section 14): surfaces darken, hairlines lift, the yellow
does not move and keeps `--on-amber` ink text on it. `assets/agentline.css` section 16 covers the
places a token alone cannot: the yellow sidebar and the yellow device-preview surround **redefine
the ink tokens back to their light values inside themselves**, because they are light surfaces
whatever the theme; the select arrow is redrawn in the dark muted grey; and the switch track,
`--night` blocks and the notification badge get explicit values.

Under 900px the sidebar is a drawer, and `.shell.is-rail` would otherwise out-specify the
responsive rule and claim a 64px grid column. `assets/agentline.css` overrides the rail inside the
900px media query — including the stacked brand row and the stacked footer pairs — so the drawer
keeps its full width and its labels regardless of the setting, and it hides the collapse control
there because a drawer has nothing to collapse.

## Installable app

Agentline is a progressive web app. Three pieces:

| File | Role |
|---|---|
| `manifest.webmanifest` | `Agentline`, `start_url` and `scope` both `./` so it works from a GitHub Pages subdirectory, `display: standalone`, `background_color: #FFFFFF`, `theme_color: #EAC81C`, three icons (192 any, 512 any, 512 maskable), `lang: en`. |
| `sw.js` | Registered at the app root so its scope covers the whole app. `install` pre-caches an explicit `SHELL` array — every HTML, CSS, JS module, the manifest and the icons — into one versioned cache; `activate` deletes any older cache under the same scope; `fetch` is cache-first for same-origin, shell-fallback for navigations, network-first for the font stylesheet. |
| `lib/pwa.js` | Copied from the kit. Registers the worker, captures `beforeinstallprompt`, and renders the **Install app** control, hidden until the browser says installing is possible. iOS has no prompt event, so there the control explains Share → Add to Home Screen. |

`main.js` calls it once at boot and routes its messages through the app's toast:

```js
const installRow = h('div', { class: 'side__pair' });
const installBtn = initPWA({ mount: installRow, appName: 'Agentline', onNote: (msg) => toast(msg) });
```

The control is mounted into the last footer row — the one it shares with **Reset demo data** —
rather than straight into `#sidefoot`, because `paintFoot()` clears the footer on every sidebar
repaint. That row is created once outside `paintFoot()` and re-appended, so the button keeps the
deferred prompt and its listeners. `initPWA` appends, so `main.js` moves the returned control to
the head of the row; while it is hidden `[hidden]{display:none!important}` takes it out of the flex
row entirely and **Reset demo data** spans the row on its own.

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
- Icon-only controls carry `aria-label` and `title` — step reorder and removal, switches, drawer
  close, the menu button, the assistant launcher, both sidebar toggles, and the three top-bar
  controls. The bell's accessible name carries the unread count, so the badge is never the only
  signal.
- The top bar sheds weight rather than overflowing: the sub-label goes at 900px, **Reset demo data**
  at 760px (the sidebar footer keeps one), and at 640px the device control shows only the button
  that would change something. Nothing on any screen exceeds 390px.
- The notification panel is anchored under the bell on a wide screen and pinned to the viewport
  edges under 640px, so it can never open off-screen.
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
- Actions understand the phrasings in `ACTION_CATALOGUE` and close variations of them. They are
  regular expressions, not language understanding: an unusual sentence falls through to an ordinary
  answer or the fallback line, never to a silent change.
- Device preview is a same-origin iframe, so it shares the workspace with the desktop copy. It is a
  layout preview, not a device emulator — touch behaviour, pointer coarseness and mobile browser
  chrome are still your desktop browser's.
