// Replays ONE eval case and prints what the model returned and what the agent replied at each step.
//   node --env-file=.env scripts/debug-case.mjs en-dispute
import fs from 'node:fs';
import { createStore } from '../src/ledger/store.js';
import { createLedgerService } from '../src/ledger/service.js';
import { createAgent } from '../src/agent.js';

const id = process.argv[2];
const cases = JSON.parse(fs.readFileSync(process.env.CASES ?? 'eval/cases.json', 'utf8'));
const c = cases.find((x) => x.id === id);
if (!c) { console.error('No such case. Ids:', cases.map((x) => x.id).join(', ')); process.exit(1); }

const base = process.env.INTERPRETER === 'llm'
  ? (await import('../src/ai/interpret.llm.js')).interpretLLM
  : (await import('../src/ai/interpret.mock.js')).interpretMock;
const T0 = Date.parse('2026-10-05T10:00:00.000Z');
let nowMs = T0;
const store = createStore();
const service = createLedgerService({ store, now: () => new Date(nowMs) });
c.customers.forEach((x) => service.addCustomer(x));
let last;
const agent = createAgent({ service, interpret: async (t, ctx) => { last = await base(t, ctx); return last; } });
let session = agent.newSession();

for (const step of c.steps) {
  if (step.newSession) { session = agent.newSession(); console.log('--- new session'); }
  else if (step.clockDays) { nowMs = T0 + step.clockDays * 86_400_000; service.setDemoClock(new Date(nowMs).toISOString()); console.log(`--- clock +${step.clockDays}d`); }
  else {
    const r = await session.handle(step.say);
    const { customerName, customerSpoken, amount, items, correction, confidence, ambiguity } = last ?? {};
    console.log(`\nSAY:    ${step.say}`);
    console.log(`MODEL:  ${last?.intent} customer=${customerName} spoken=${customerSpoken} amount=${amount} items=${JSON.stringify(items)} correction=${JSON.stringify(correction)} conf=${confidence} amb=${ambiguity}`);
    console.log(`REPLY:  ${r.reply}`);
  }
}