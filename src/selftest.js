/* ============================================================
   Agentline — routing self-test.

   Every string a reader can click, and every instruction the product
   claims an agent understands, must reach a real intent. A suggestion
   that lands on the fallback line is the worst first impression the
   product can make, so this checks the lot:

     - the console's own suggestion chips
     - each agent's suggestion chips (including the generic default)
     - the three guardrail probe buttons, against every agent
     - every action phrase in the catalogue, against the agent that
       claims it, checked twice: it must route to the intent it says it
       routes to, and that intent must actually offer a runnable button

   Run it from the browser console:  await agentline.selfTest()
   It routes and composes only. Nothing is applied: an action mutates
   the workspace inside run(), and run() is never called here.
   ============================================================ */

import {
  buildAgentBot, buildConsoleBot, suggestionsFor,
  consoleSuggestions, guardrailProbes, actionProbes,
} from './agent.js';

function probe(bot, source, question, { expect = null, wantAction = false } = {}) {
  let intent = null;
  let error = null;
  let actions = 0;
  try {
    const hit = bot._route(question);
    intent = hit && hit.id ? hit.id : null;
    if (intent && wantAction) {
      const out = typeof hit.answer === 'function' ? hit.answer(question, bot.cfg.context() || {}) : hit.answer;
      actions = (out && out.actions ? out.actions.filter((a) => a && typeof a.run === 'function') : []).length;
    }
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  const routed = !!intent && !error && (!expect || intent === expect);
  return {
    source, question, intent, expect, actions, error,
    ok: routed && (!wantAction || actions > 0),
  };
}

export function selfTest(store, { log = true } = {}) {
  const state = store.state;
  const results = [];
  const counts = { chips: 0, probes: 0, actions: 0 };

  /* ---- console ---- */
  const consoleBot = buildConsoleBot(store);
  consoleSuggestions().forEach((q) => {
    counts.chips += 1;
    results.push(probe(consoleBot, 'Agentline Console · chip', q));
  });
  actionProbes().filter((p) => p.scope === 'console').forEach((p) => {
    counts.actions += 1;
    results.push(probe(consoleBot, 'Agentline Console · action', p.q, { expect: p.expect, wantAction: true }));
  });

  /* ---- one bot per agent ---- */
  state.agents.forEach((agent) => {
    const bot = buildAgentBot(store, agent);
    suggestionsFor(agent).forEach((q) => {
      counts.chips += 1;
      results.push(probe(bot, `${agent.name} · chip`, q));
    });
    guardrailProbes().forEach((p) => {
      counts.probes += 1;
      results.push(probe(bot, `${agent.name} · probe`, p.q));
    });
    actionProbes().filter((p) => p.scope === agent.id || p.scope === 'shared').forEach((p) => {
      counts.actions += 1;
      results.push(probe(bot, `${agent.name} · action`, p.q, { expect: p.expect, wantAction: true }));
    });
  });

  const failures = results.filter((r) => !r.ok);
  const summary = {
    tested: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    chips: counts.chips,
    probes: counts.probes,
    actionIntents: counts.actions,
    agents: state.agents.length,
    results,
    failures,
  };

  if (log) {
    if (failures.length) {
      console.error(`Agentline self-test: ${failures.length} of ${results.length} checks failed.`);
      failures.forEach((f) => console.error(
        `  [${f.source}] "${f.question}" -> ${f.error || (f.expect && f.intent !== f.expect ? `routed to ${f.intent}, expected ${f.expect}` : f.intent ? `${f.intent} offered no runnable action` : 'no intent matched')}`,
      ));
    } else {
      console.info(
        `Agentline self-test: ${results.length} checks passed across ${state.agents.length} agents plus the console — `
        + `${counts.chips} suggestion chips, ${counts.probes} guardrail probes, ${counts.actionIntents} action intents `
        + '(each routed to the expected intent and offering at least one runnable button).',
      );
    }
  }
  return summary;
}
