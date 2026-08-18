/* ============================================================
   Agentline — seeded demo dataset.
   Everything below is invented sample data generated from a fixed
   seed, so the numbers are identical on every reload until the user
   changes something. Nothing here talks to a network.
   ============================================================ */

import { seeded, between, pick, isoDay } from '../lib/ui.js';
import { dataLabel } from './strings.js';
import { t } from './main.js';

export const STORE_KEY = 'agentline.demo.v1';

/* Neutral in-product model names. These are labels on demo records,
   not references to anything that exists. */
export const MODELS = [
  { id: 'reasoning-core', label: 'reasoning-core', note: 'Long-context planner. Slower, best on messy input.' },
  { id: 'reasoning-core-mini', label: 'reasoning-core-mini', note: 'Same planner, smaller budget.' },
  { id: 'fast-1', label: 'fast-1', note: 'Low latency, short answers.' },
  { id: 'extract-2', label: 'extract-2', note: 'Field extraction from documents.' },
];

export const TOKEN_RATE = { in: 0.012, out: 0.045 }; // paise per token, demo pricing

const CUSTOMERS = [
  'Kerala Coast Foods', 'Northline Traders', 'Jeddah Facilities Co', 'Vayal Organics',
  'Al Rawdah Trading', 'Calicut Timber Mart', 'Perinthal Logistics', 'Riyadh Fitout Works',
  'Marikkar Hardware', 'Anjali Textiles', 'Bay Harvest Marine', 'Salalah Cold Chain',
];
const PEOPLE = [
  'Meera Raghavan', 'Anil Kurup', 'Fatima Al-Harbi', 'Rahul Menon', 'Sana Iqbal',
  'Joseph Chandy', 'Devika Nair', 'Omar Bin Saleh', 'Nithya Balan', 'Imran Sait',
];
const VENDORS = [
  'Southline Packaging', 'Beacon Print House', 'Palakkad Steel Co', 'Gulf Office Supply',
  'Ernakulam Freight', 'Nadeem Electricals', 'Kochi Cold Store', 'Tabuk Stationery',
];
const TICKET_SUBJECTS = [
  'Order stuck at packing for two days', 'Wrong quantity delivered', 'Need a duplicate invoice',
  'Cannot log in after the plan change', 'Delivery address is wrong on the note',
  'Asking for a refund on order 4471', 'Weekly report did not arrive', 'Card payment failed twice',
  'Requesting an extra user seat', 'Export to sheet is empty', 'Damaged carton on arrival',
  'Price list looks out of date',
];
const CATEGORIES = ['Billing', 'Delivery', 'Account', 'Product', 'Reporting'];
const CHANNELS = ['Email', 'Web form', 'Phone note', 'Chat'];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
const emailFor = (person, company) => `${slug(person.split(' ')[0])}@${slug(company).split('.').slice(0, 2).join('')}.example`;
const phoneFor = (rnd) => `+91 90${between(100000, 999999, rnd)}`;

/* ---------- tools ---------- */
function seedTools(rnd) {
  const defs = [
    ['email', 'Email', 'mail', 'Shared mailbox', 'ops-inbox · demo mailbox', ['inbox.search', 'mail.draft', 'mail.send'],
      'Reads the shared support and accounts mailbox and sends replies that an agent has drafted.'],
    ['crm', 'CRM', 'users', 'Customer records', 'workspace 4412 · demo tenant', ['contact.lookup', 'account.read', 'note.append'],
      'Looks up the customer behind a ticket: plan, owner, open value and the last three notes.'],
    ['sheets', 'Sheets', 'table', 'Finance workbook', 'workbook: operations Q3', ['sheet.read', 'row.append', 'range.update'],
      'Reads and appends rows in the operations workbook that finance and reporting run on.'],
    ['ticketing', 'Ticketing', 'file', 'Helpdesk', 'queue INB · 4 views', ['ticket.search', 'ticket.classify', 'ticket.update'],
      'The inbound queue. Agents read, classify, re-prioritise and route tickets here.'],
    ['webhook', 'Webhook', 'bolt', 'Outbound hook', 'POST /hooks/agentline · demo endpoint', ['hook.post'],
      'Fires a signed payload at whatever downstream system you point it at. Nothing is actually sent in the demo.'],
  ];
  return defs.map(([id, name, ic, kind, account, ops, description]) => ({
    id, name, icon: ic, kind, account, ops, description,
    connected: true,
    calls30d: between(220, 2600, rnd),
    latencyMs: between(60, 420, rnd),
    connectedAt: new Date(Date.now() - between(20, 180, rnd) * 86400000).toISOString(),
  }));
}

/* ---------- guardrails ---------- */
function seedGuardrails() {
  return [
    {
      id: 'pii', name: 'PII redaction', kind: 'redact', enabled: true,
      summary: 'Mask contact details in anything an agent writes back.',
      detail: 'Applied to the reply text and to every table cell after the answer is composed.',
      masks: ['Email address', 'Phone number', 'Account number'],
    },
    {
      id: 'topics', name: 'Allowed topics', kind: 'topics', enabled: true,
      summary: 'Refuse anything outside the approved topic list.',
      detail: 'A question that matches none of the topics and hits a blocked term is answered with a refusal instead.',
      topics: ['orders', 'billing', 'onboarding', 'product setup', 'invoices', 'reporting'],
      blocked: ['salary', 'password', 'medical', 'politics', 'hiring', 'personal address'],
    },
    {
      id: 'escalate', name: 'Escalation to human', kind: 'escalate', enabled: true,
      summary: 'Hand the conversation to a person when the request matches an escalation trigger.',
      detail: 'The agent stops, writes a handover note and raises a reference in the named queue.',
      queue: 'Tier 2 · Kochi desk',
      triggers: ['refund', 'legal', 'cancel contract', 'complaint', 'angry', 'escalate', 'lawyer'],
    },
    {
      id: 'cost', name: 'Max cost per run', kind: 'cost', enabled: true,
      summary: 'Stop a run once its estimated cost passes the ceiling.',
      detail: 'Cost is estimated from tokens in and out at the workspace rate. A run over the ceiling is truncated and marked blocked.',
      limitPaise: 200,
    },
  ];
}

/* ---------- agents ---------- */
function seedAgents(rnd) {
  return [
    {
      id: 'triage', name: 'Support Triage', initials: 'ST', status: 'live',
      purpose: 'Reads every inbound ticket, sets priority and routes it to the right desk.',
      description: 'Runs on the inbound queue. It pulls the ticket, looks the customer up in the CRM, classifies the request into one of five categories, sets a priority from the wording and the customer plan, then drafts a reply for a person to approve. Anything matching an escalation trigger is handed straight over.',
      model: 'reasoning-core', owner: 'Meera Raghavan',
      tools: ['ticketing', 'crm', 'email'],
      guardrails: ['pii', 'topics', 'escalate', 'cost'],
      successRate: 94.2, runs30d: 1284, avgLatencyMs: 1420, avgTokens: { in: 1180, out: 260 },
      createdAt: '2026-03-11',
    },
    {
      id: 'invoice', name: 'Invoice Reader', initials: 'IR', status: 'live',
      purpose: 'Extracts fields from supplier invoices and checks them against the purchase order.',
      description: 'Watches the accounts mailbox for attachments, extracts vendor, invoice number, date, tax and line totals, then validates the sum against the purchase order reference. Clean invoices are appended to the finance workbook. Anything below the confidence floor is parked for review instead of posted.',
      model: 'extract-2', owner: 'Joseph Chandy',
      tools: ['email', 'sheets', 'webhook'],
      guardrails: ['pii', 'cost'],
      successRate: 97.6, runs30d: 612, avgLatencyMs: 2260, avgTokens: { in: 2140, out: 180 },
      createdAt: '2026-02-02',
    },
    {
      id: 'onboard', name: 'Onboarding Assistant', initials: 'OA', status: 'live',
      purpose: 'Walks a new account through setup and answers product questions during the first two weeks.',
      description: 'Owns the first fourteen days of an account. It knows the six-step setup checklist, can say exactly where an account is stuck, answers how-to questions from the product notes, and books a call with the account owner when a customer asks for one.',
      model: 'fast-1', owner: 'Devika Nair',
      tools: ['crm', 'email', 'sheets'],
      guardrails: ['pii', 'topics', 'escalate'],
      successRate: 91.8, runs30d: 438, avgLatencyMs: 860, avgTokens: { in: 720, out: 320 },
      createdAt: '2026-04-19',
    },
    {
      id: 'report', name: 'Report Writer', initials: 'RW', status: 'paused',
      purpose: 'Pulls the weekly numbers out of the workbook and writes the Monday summary.',
      description: 'Scheduled agent. Reads the operations workbook, compares the current week against the previous one, calls out anything that moved more than ten per cent, and writes a short summary for the distribution list. Paused while the workbook columns are being reorganised.',
      model: 'reasoning-core', owner: 'Rahul Menon',
      tools: ['sheets', 'crm', 'email'],
      guardrails: ['pii', 'topics', 'cost'],
      successRate: 89.4, runs30d: 96, avgLatencyMs: 3140, avgTokens: { in: 3260, out: 640 },
      createdAt: '2026-01-26',
    },
  ];
}

/* ---------- workflows ---------- */
function seedWorkflows() {
  const step = (id, name, kind, ref, avgMs, detail) => ({ id, name, kind, ref, avgMs, detail, enabled: true });
  return [
    {
      id: 'wf-triage', name: 'Inbound support triage', enabled: true,
      description: 'Every mail landing in the support mailbox becomes a classified, routed ticket with a drafted reply.',
      trigger: { kind: 'event', label: 'New mail in support mailbox', detail: 'Polled every 60 seconds' },
      steps: [
        step('s1', 'Fetch ticket', 'tool', 'ticketing', 180, 'ticket.search by message id'),
        step('s2', 'Classify and prioritise', 'agent', 'triage', 940, 'category, priority, sentiment'),
        step('s3', 'Enrich from CRM', 'tool', 'crm', 260, 'contact.lookup + account.read'),
        step('s4', 'Draft reply', 'agent', 'triage', 780, 'reply drafted for approval'),
        step('s5', 'Update ticket', 'tool', 'ticketing', 210, 'ticket.update with owner and priority'),
      ],
      outputs: ['Ticket routed with priority', 'Draft reply attached', 'CRM note appended'],
      runs30d: 1284, lastRunAt: null,
    },
    {
      id: 'wf-invoice', name: 'Invoice intake', enabled: true,
      description: 'Attachments in the accounts mailbox are read, validated against the purchase order and appended to the workbook.',
      trigger: { kind: 'event', label: 'Attachment in accounts mailbox', detail: 'PDF or image, up to 8 pages' },
      steps: [
        step('s1', 'Pull attachment', 'tool', 'email', 240, 'inbox.search unread with attachment'),
        step('s2', 'Extract fields', 'agent', 'invoice', 1680, 'vendor, number, date, tax, totals'),
        step('s3', 'Validate against PO', 'condition', null, 120, 'line total equals PO total within ₹5'),
        step('s4', 'Append to workbook', 'tool', 'sheets', 320, 'row.append to Payables Q3'),
        step('s5', 'Notify downstream', 'tool', 'webhook', 150, 'hook.post invoice.posted'),
      ],
      outputs: ['Row in Payables Q3', 'Exception list for low confidence', 'Downstream hook fired'],
      runs30d: 612, lastRunAt: null,
    },
    {
      id: 'wf-report', name: 'Weekly operations report', enabled: false,
      description: 'Monday morning pull of the week numbers, written up and mailed to the distribution list.',
      trigger: { kind: 'schedule', label: 'Every Monday 08:00 IST', detail: 'Skips public holidays' },
      steps: [
        step('s1', 'Read metrics range', 'tool', 'sheets', 410, 'sheet.read Ops!A1:H60'),
        step('s2', 'Compare to last week', 'agent', 'report', 1120, 'per-metric delta'),
        step('s3', 'Write summary', 'agent', 'report', 1980, 'six paragraphs, plain language'),
        step('s4', 'Send to list', 'tool', 'email', 280, 'mail.send to ops-weekly'),
      ],
      outputs: ['Summary mail to ops-weekly', 'Archived copy in the workbook'],
      runs30d: 96, lastRunAt: null,
    },
  ];
}

/* ---------- business records the agents actually read ---------- */
function seedTickets(rnd) {
  const out = [];
  for (let i = 0; i < 26; i++) {
    const customer = pick(CUSTOMERS, rnd);
    const person = pick(PEOPLE, rnd);
    const ageH = between(1, 96, rnd);
    const priority = ageH > 60 ? pick(['High', 'Urgent'], rnd) : pick(['Low', 'Normal', 'Normal', 'High'], rnd);
    out.push({
      id: `TCK-${2040 + i}`,
      subject: pick(TICKET_SUBJECTS, rnd),
      customer, contact: person,
      email: emailFor(person, customer),
      phone: phoneFor(rnd),
      channel: pick(CHANNELS, rnd),
      category: pick(CATEGORIES, rnd),
      priority,
      sentiment: pick(['calm', 'calm', 'neutral', 'frustrated'], rnd),
      status: pick(['open', 'open', 'waiting', 'resolved'], rnd),
      ageH,
      assignee: pick(PEOPLE, rnd),
      firstReplyMins: between(6, 240, rnd),
    });
  }
  return out;
}

function seedInvoices(rnd) {
  const out = [];
  for (let i = 0; i < 22; i++) {
    const amount = between(4200, 186000, rnd);
    const conf = between(62, 99, rnd);
    const status = conf < 80 ? 'needs review' : conf < 85 ? 'failed' : 'extracted';
    out.push({
      id: `INV-${8820 + i}`,
      vendor: pick(VENDORS, rnd),
      amount,
      taxPct: pick([5, 12, 18, 18], rnd),
      dateIso: isoDay(new Date(Date.now() - between(1, 40, rnd) * 86400000)),
      po: `PO-${between(3100, 3999, rnd)}`,
      confidence: conf,
      status,
      lines: between(1, 9, rnd),
      variance: status === 'extracted' ? 0 : between(-3400, 5200, rnd),
      postedToSheet: status === 'extracted',
    });
  }
  return out;
}

const STEPS = ['Workspace created', 'Team invited', 'Catalogue imported', 'Payment set up', 'First order placed', 'Report scheduled'];

function seedAccounts(rnd) {
  const out = [];
  for (let i = 0; i < 16; i++) {
    const name = CUSTOMERS[i % CUSTOMERS.length];
    const stepIdx = between(0, 5, rnd);
    const person = pick(PEOPLE, rnd);
    out.push({
      id: `ACC-${520 + i}`,
      name: i < CUSTOMERS.length ? name : `${name} (branch ${i - CUSTOMERS.length + 2})`,
      plan: pick(['Starter', 'Growth', 'Growth', 'Scale'], rnd),
      stepIdx, step: STEPS[stepIdx],
      stuckDays: stepIdx === 5 ? 0 : between(0, 11, rnd),
      owner: pick(PEOPLE, rnd),
      contact: person,
      email: emailFor(person, name),
      region: pick(['Kerala', 'Karnataka', 'Riyadh', 'Jeddah', 'Tamil Nadu'], rnd),
      seats: between(2, 40, rnd),
    });
  }
  return out;
}

function seedMetrics(rnd) {
  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    const runs = between(380, 720, rnd);
    weeks.push({
      label: `W${8 - w}`,
      runs,
      success: Math.round(runs * (0.88 + rnd() * 0.1)),
      escalations: between(4, 26, rnd),
      tokens: runs * between(900, 1600, rnd),
      costPaise: runs * between(18, 42, rnd),
    });
  }
  return weeks;
}

/* ---------- runs ---------- */
const TRIGGERS = ['Workflow', 'Playground', 'Schedule', 'Webhook'];

function traceFor(agent, workflow, status, rnd) {
  const t = [];
  const add = (label, kind, st, ms, detail) => t.push({ label, kind, status: st, ms, detail });
  add('Run accepted', 'system', 'ok', between(4, 20, rnd), `model ${agent.model}`);
  if (workflow) {
    workflow.steps.forEach((s, i) => {
      const last = status !== 'success' && i === workflow.steps.length - 2;
      add(s.name, s.kind, last ? (status === 'escalated' ? 'escalated' : 'failed') : 'ok',
        Math.round(s.avgMs * (0.6 + rnd() * 0.9)), s.detail);
    });
  } else {
    add('Plan', 'agent', 'ok', between(60, 190, rnd), 'one tool call planned');
    agent.tools.slice(0, 2).forEach((tid) => add(`${tid}.read`, 'tool', 'ok', between(90, 420, rnd), `${tid} responded`));
    add('Compose answer', 'agent', status === 'failed' ? 'failed' : 'ok', between(240, 900, rnd), 'streamed to caller');
  }
  add('Guardrails', 'guardrail', status === 'blocked' ? 'blocked' : 'ok', between(3, 14, rnd),
    status === 'blocked' ? 'cost ceiling reached' : 'all checks passed');
  return t;
}

function seedRuns(rnd, agents, workflows) {
  const out = [];
  for (let i = 0; i < 46; i++) {
    const agent = pick(agents, rnd);
    const useWf = rnd() > 0.35;
    const wf = useWf ? pick(workflows, rnd) : null;
    const roll = rnd();
    const status = roll > 0.86 ? 'failed' : roll > 0.78 ? 'escalated' : roll > 0.74 ? 'blocked' : 'success';
    const tokensIn = Math.round(agent.avgTokens.in * (0.6 + rnd() * 0.8));
    const tokensOut = Math.round(agent.avgTokens.out * (0.5 + rnd() * 1.1));
    const startedAt = new Date(Date.now() - between(20, 20000, rnd) * 60000).toISOString();
    const trace = traceFor(agent, wf, status, rnd);
    out.push({
      id: `run_${(1024 + i).toString(36)}${between(100, 999, rnd)}`,
      agentId: agent.id,
      workflowId: wf ? wf.id : null,
      trigger: wf ? 'Workflow' : pick(TRIGGERS, rnd),
      status, startedAt,
      durationMs: trace.reduce((s, x) => s + x.ms, 0),
      tokensIn, tokensOut,
      costPaise: Math.round(tokensIn * TOKEN_RATE.in + tokensOut * TOKEN_RATE.out),
      guardrails: agent.guardrails.map((g) => ({ id: g, verdict: status === 'blocked' && g === 'cost' ? 'blocked' : 'passed' })),
      trace,
    });
  }
  return out.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

/* ---------- the seed itself ---------- */
export function seedState() {
  const rnd = seeded(20260808);
  const tools = seedTools(rnd);
  const guardrails = seedGuardrails();
  const agents = seedAgents(rnd);
  const workflows = seedWorkflows();
  const runs = seedRuns(rnd, agents, workflows);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings: {
      workspace: 'Anvaya Systems',
      environment: 'sandbox',
      defaultModel: 'reasoning-core',
      streaming: true,
      retentionDays: 30,
      region: 'ap-south · Mumbai',
      traceSampling: 100,
      notifyOn: 'failed and escalated runs',
      distribution: 'ops-weekly',
    },
    tools, guardrails, agents, workflows, runs,
    tickets: seedTickets(rnd),
    invoices: seedInvoices(rnd),
    accounts: seedAccounts(rnd),
    metrics: seedMetrics(rnd),
    /* written by the Report Writer when it is told to store a summary;
       listed on the Settings screen */
    reports: [],
    counters: { runSeq: 1, agentSeq: 1, escalationSeq: 4180 },
  };
}

/* ---------- helpers shared by views and the intent packs ---------- */
export const ONBOARD_STEPS = STEPS;

export const agentById = (s, id) => s.agents.find((a) => a.id === id);
export const toolById = (s, id) => s.tools.find((t) => t.id === id);
export const guardById = (s, id) => s.guardrails.find((g) => g.id === id);
export const workflowById = (s, id) => s.workflows.find((w) => w.id === id);

export const isConnected = (s, id) => { const t = toolById(s, id); return !!(t && t.connected); };
export const guardActive = (s, agent, id) => {
  const g = guardById(s, id);
  return !!(g && g.enabled && agent && agent.guardrails.includes(id));
};

export const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;
export const estimateCost = (tIn, tOut) => Math.round(tIn * TOKEN_RATE.in + tOut * TOKEN_RATE.out);
export const newRunId = () => `run_${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;

/* ---------- the record side, read in the chosen language ----------
   Every seeded record stores its English string, and that string is the
   key. A value with no entry — a name, a company, an id, an agent someone
   created here — comes back untouched, in Latin, which is right. */
export const dl = (group, value) => dataLabel(t, group, value);

export const toolName = (x) => (x ? dl('toolName', x.name) : undefined);
export const toolKind = (x) => dl('toolKind', x.kind);
export const toolAccount = (x) => dl('toolAccount', x.account);
export const toolDesc = (x) => dl('toolDesc', x.description);

export const agentName = (a) => (a ? dl('agentName', a.name) : undefined);
export const agentPurpose = (a) => dl('agentPurpose', a.purpose);
export const agentDesc = (a) => dl('agentDesc', a.description);
export const agentStatusLabel = (v) => dl('agentStatus', v);

export const guardName = (g) => (g ? dl('guardName', g.name) : undefined);
export const guardSummary = (g) => dl('guardSummary', g.summary);
export const guardDetail = (g) => dl('guardDetail', g.detail);
export const guardQueue = (g) => dl('queue', (g || {}).queue);
export const termLabel = (v) => dl('term', v);
export const maskLabel = (v) => dl('mask', v);

export const workflowName = (w) => (w ? dl('wfName', w.name) : undefined);
export const workflowDesc = (w) => dl('wfDesc', w.description);
export const triggerLabel = (w) => dl('trigLabel', w.trigger.label);
export const triggerDetail = (w) => dl('trigDetail', w.trigger.detail);
export const outputLabel = (v) => dl('output', v);
export const stepName = (v) => dl('stepName', v);
export const stepDetail = (v) => dl('stepDetail', v);

export const statusLabel = (v) => dl('status', v);
export const verdictLabel = (v) => dl('verdict', v);
export const traceStatusLabel = (v) => dl('traceStatus', v);
export const kindLabel = (v) => dl('kind', v);
export const triggerName = (v) => dl('trigger', v);
/* A trace event written by the run engine carries a step's name and a
   step's detail, which live in their own groups. Try the trace groups
   first, then fall through, so a workflow trace reads the same on the
   Runs screen as it does on the Workflows screen. */
export const traceLabel = (v) => {
  const a = dl('traceLabel', v);
  return a !== v ? a : dl('stepName', v);
};
export const traceDetail = (v) => {
  const a = dl('traceDetail', v);
  if (a !== v) return a;
  const b = dl('stepDetail', v);
  if (b !== v) return b;
  return dl('trigLabel', v);
};
export const modelNote = (v) => dl('modelNote', v);

export const priorityLabel = (v) => dl('priority', v);
export const categoryLabel = (v) => dl('category', v);
export const channelLabel = (v) => dl('channel', v);
export const sentimentLabel = (v) => dl('sentiment', v);
export const ticketStatusLabel = (v) => dl('ticketStatus', v);
export const subjectLabel = (v) => dl('subject', v);
export const invStatusLabel = (v) => dl('invStatus', v);
export const planLabel = (v) => dl('plan', v);
export const onboardStepLabel = (v) => dl('step', v);
export const regionLabel = (v) => dl('region', v);
export const envLabel = (v) => dl('env', v);
export const settingsRegionLabel = (v) => dl('settingsRegion', v);
export const notifyLabel = (v) => dl('notify', v);

export const STATUS_PILL = {
  success: 'pill--ok', failed: 'pill--bad', escalated: 'pill--warn', blocked: 'pill--info', running: 'pill--amber',
};
export const AGENT_PILL = { live: 'pill--ok', paused: 'pill--warn', draft: '' };
