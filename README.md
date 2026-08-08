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

## How this demo works

**You can actually use it.** Build workflows, add and remove steps, run them, toggle tools and
guardrails, create agents, talk to them. Nothing here is read-only and nothing is a screenshot.

**Your data stays on your machine.** Everything you enter is saved in this browser's local storage.
Nothing is sent to a server, there is no account and no backend. Clear your browser data, or use
**Reset demo data**, and it is all gone. It does not sync between browsers or devices.

**The agents are simulated.** Every reply, tool call, token count and latency figure is generated
locally from this app's demo data to show how the product behaves. No AI model is connected and no
request leaves your browser. What this demonstrates is the interface, the traces and the guardrail
behaviour — not model quality.

The same three points are in the app, behind the **Demo** pill in the top bar and the
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
the navigation to a 64px icon rail, and **Yellow** switches the sidebar to the brand colour.

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
  assets/app.css          shared design system (copied, unmodified)
  assets/agentline.css    components used only by this app
  lib/ui.js               DOM, router, store, formatting, icons (copied)
  lib/assistant.js        assistant engine (copied)
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
- State is written to one `localStorage` key, `agentline.demo.v1`.
- Run history is capped at 90 entries.
- Currency is `₹`. Costs are shown in rupees at a made-up token rate.
- The only request the page makes to another origin is the font stylesheet in the document head.
  There is no `fetch` anywhere in the source.

## Licence

MIT — see [LICENSE](LICENSE).
