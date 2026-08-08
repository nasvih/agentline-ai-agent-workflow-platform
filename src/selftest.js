/* ============================================================
   Agentline — suggestion routing self-test.

   Every string that can appear as a clickable chip must route to a real
   intent. A suggestion that lands on the fallback line is the worst
   first impression the product can make, so this checks the lot:

     - the console's own suggestion chips
     - each agent's suggestion chips (including the generic default)
     - the three guardrail probe buttons, against every agent
     - the chips shown after a reply, which fall through to the same lists

   Run it from the browser console:  await agentline.selfTest()
   It routes questions only — no answers are composed and no runs are
   written, so it is safe to run at any time.
   ============================================================ */

import {
  buildAgentBot, buildConsoleBot, suggestionsFor,
  CONSOLE_SUGGESTIONS, GUARDRAIL_PROBES,
} from './agent.js';

function probe(bot, source, question) {
  let intent = null;
  let error = null;
  try {
    const hit = bot._route(question);
    intent = hit && hit.id ? hit.id : null;
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  return { source, question, intent, ok: !!intent && !error, error };
}

export function selfTest(store, { log = true } = {}) {
  const state = store.state;
  const results = [];

  const consoleBot = buildConsoleBot(store);
  CONSOLE_SUGGESTIONS.forEach((q) => results.push(probe(consoleBot, 'Agentline Console', q)));

  state.agents.forEach((agent) => {
    const bot = buildAgentBot(store, agent);
    suggestionsFor(agent).forEach((q) => results.push(probe(bot, `${agent.name} · chip`, q)));
    GUARDRAIL_PROBES.forEach((p) => results.push(probe(bot, `${agent.name} · probe`, p.q)));
  });

  const failures = results.filter((r) => !r.ok);
  const summary = {
    tested: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    agents: state.agents.length,
    results,
    failures,
  };

  if (log) {
    if (failures.length) {
      console.error(`Agentline self-test: ${failures.length} of ${results.length} suggestions fall through to the fallback.`);
      failures.forEach((f) => console.error(`  [${f.source}] "${f.question}" -> ${f.error || 'no intent matched'}`));
    } else {
      console.info(`Agentline self-test: ${results.length} suggestions checked across ${state.agents.length} agents plus the console, all routed to a real intent.`);
    }
  }
  return summary;
}
