# Agentline

A demo workspace for building agents, wiring them into workflows, watching every run and
holding them to guardrails.

Four agents sit on top of a small set of business records — a support queue, a pile of supplier
invoices, a book of onboarding accounts and eight weeks of operations metrics. Each one has its own
tools, its own guardrails and its own intent pack, so the same question gets a different answer
depending on who you ask. Workflows chain them together. Every turn and every workflow run is
recorded with a full trace.

Part of a suite of six standalone demo applications.
**Muhammed Nasvih V** — [nasvih.in](https://www.nasvih.in) · [github.com/nasvih](https://github.com/nasvih)

---

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

## How this demo works

**You can actually use it.** Build workflows, add and remove steps, run them, toggle tools and
guardrails, create agents, talk to them. Nothing here is read-only and nothing is a screenshot.

**Your data stays on your machine.** Everything you enter is saved in this browser's local storage.
There is no account and no backend. Clear your browser data, or use **Reset demo data**, and it is
all gone. It does not sync between browsers or devices.

**The agents are simulated.** Every reply, tool call, token count and latency figure is generated
locally from this app's demo data. No model is connected and no request leaves your browser.

The same four blocks are in the app, behind the **Demo** pill in the top bar and the
**About this demo** item in the sidebar footer.

---

## Screens

| Screen | What it does |
|---|---|
| **Agents** | The four demo agents plus any you create. Description, model, tools, guardrails, status, success rate, 30-day volume. Pause or activate, edit the definition, open a detail drawer with recent runs, create a new agent, delete one you made. |
| **Playground** | Full-page chat with the selected agent. A right rail replays the run as it happens: each simulated tool call with its duration, each guardrail check with its verdict, then tokens in, tokens out, latency and cost. Three "guardrail probe" buttons ask questions written to trip a specific rule. |
| **Workflows** | Trigger → steps → outputs, as a node list. Add a step, remove one, reorder it, disable it, enable or disable the whole workflow. **Run workflow** streams a step-by-step log with per-step status and duration, then writes a real run into Runs. |
| **Runs** | History table with status, agent and workflow filters, and CSV export. Click a run id for the full trace timeline, the guardrail verdicts and the run context. Re-run copies it forward. |
| **Tools & connections** | Email, CRM, Sheets, Ticketing, Webhook. The connect switches are real: disconnect one and every agent question and workflow step that needs it starts failing, with the reason written into the trace. A matrix at the bottom shows which agent is blocked by what. |
| **Guardrails** | PII redaction, allowed topics, escalation to human, max cost per run. Each has a switch and a live configuration — topic lists, trigger words, handover queue, cost ceiling — plus a redaction preview you can type into. Toggling any of them changes the next reply in the Playground. |
| **Settings** | Workspace name, environment, default model, region, retention, trace sampling, notifications, distribution list, streaming. Agent CSV export and the reset. |

Plus the **Agentline Console**, the workspace-wide assistant. It has exactly one entry point — the
round launcher at the bottom right, or <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd> — and it
answers about run health, failures, escalations, cost, connections, guardrails, workflows and any
single agent. The launcher steps aside on the Playground, which is a product screen with its own
docked chat, so there is never more than one chat affordance on screen.

The sidebar footer carries two shell controls, both remembered between visits: **Collapse** shrinks
the navigation to a 64px icon rail, and the tone control switches the sidebar between the brand
yellow and plain white. **Yellow is the default** — the button reads `White` while yellow is on,
because the label says what the click does. Under it sit **Install app** (only when the browser
offers it), **Reset demo data**, **About this demo** and a link out to nasvih.in.

## Install it

Agentline is a progressive web app. Served over HTTP it registers a service worker that caches its
own shell, so it opens and works with no connection, and any browser that supports installing will
offer **Install app** in the sidebar footer — on iPhone and iPad use Share → Add to Home Screen.
Installed, it runs in its own window with the brand yellow as the theme colour.

Nothing about this changes where the data lives: still `localStorage`, still this device only.

| File | Role |
|---|---|
| `manifest.webmanifest` | Name, icons, `standalone` display, `#EAC81C` theme colour, `./` scope |
| `sw.js` | Cache-first service worker over an explicit list of this app's files |
| `lib/pwa.js` | Registers the worker and drives the install control |

When you add or rename a file in the app, add it to the `SHELL` array in `sw.js` and bump
`CACHE_VERSION` in the same file, or the old copy keeps being served.

## Run it

No install, no build step, no dependencies. Any static file server will do.

```bash
cd agentline
python3 -m http.server 4105
# open http://localhost:4105
```

It must be served over HTTP — the app is made of ES modules, so opening `index.html` from the file
system will be blocked by the browser.

Every suggestion chip in the app has to route to a real answer. To check that yourself, open the
browser console and run:

```js
await agentline.selfTest()
// { tested: 32, passed: 32, failed: 0, agents: 4, ... }
```

It asks every chip and every guardrail probe — the console's, each agent's, and any agent you have
created — and reports anything that would fall through to a "no match" reply.

## Deploy to GitHub Pages

1. Push the repository to GitHub.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/`.
3. Wait for the first build, then open `https://<user>.github.io/<repo>/`.

`.nojekyll` is committed so that Pages serves `/lib` and `/assets` as-is. Every path in the app is
relative, so it works from a project subdirectory without changes.

## Structure

```
agentline/
  index.html              single page, hash routed
  manifest.webmanifest    installable app metadata
  sw.js                   service worker: offline shell cache
  assets/app.css          shared design system (copied, unmodified)
  assets/agentline.css    components used only by this app
  assets/icons/           192, 512 and maskable app icons
  lib/ui.js               DOM, router, store, formatting, icons (copied)
  lib/assistant.js        assistant engine (copied)
  lib/pwa.js              service worker registration + install control (copied)
  src/main.js             boot: store, nav, router, shell, console agent
  src/data.js             seeded demo dataset and helpers
  src/agent.js            intent packs and the guardrail engine
  src/selftest.js         suggestion routing self-test
  src/views/agents.js
  src/views/playground.js
  src/views/workflows.js
  src/views/runs.js
  src/views/tools.js
  src/views/guardrails.js
  src/views/settings.js
  README.md  DOCS.md  LICENSE  .gitignore  .nojekyll
```

## Demo notes

- All records are generated from a fixed seed, so the numbers are the same on every reload until
  you change something. Companies, people and figures are invented.
- State is written to one `localStorage` key, `agentline.demo.v1`. Sidebar preferences live in a
  second key, `agentline.ui.v1`, which **Reset demo data** deliberately leaves alone.
- Run history is capped at 90 entries.
- Currency is `₹`. Costs are shown in rupees at a made-up token rate.
- The only request the page makes to another origin is the font stylesheet in the document head.
  The app code contains no `fetch` at all; the only `fetch` in the repository is inside `sw.js`,
  which re-requests this app's own files to fill the offline cache.

## Licence

All rights reserved. This repository is source-available: you may read it, run it locally and evaluate it, but copying, modifying, redistributing or using it in your own work needs written permission — see [LICENSE](LICENSE).
