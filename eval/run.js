// Text-level eval harness (Day 6 starts from here).
//   npm run eval                      -> runs eval/cases.sample.json with the mock interpreter
//   CASES=eval/cases.json npm run eval
//   INTERPRETER=llm npm run eval      -> uses src/ai/interpret.llm.js (after Day 2)
//
// RULES (from the plan): write `expect` BEFORE running. Freeze the file. Never edit
// expected values after seeing failures. Report measured numbers only.
// Audio/STT evaluation is a separate stage you add later: audio -> transcript -> `say`.
import fs from 'node:fs';
import { createStore } from '../src/ledger/store.js';
import { createLedgerService } from '../src/ledger/service.js';
import { createAgent } from '../src/agent.js';
import { checkInvariants } from '../src/ledger/reducer.js';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const casesFile = process.env.CASES ?? 'eval/cases.sample.json';
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
const interpret = process.env.INTERPRETER === 'llm'
  ? (await import('../src/ai/interpret.llm.js')).interpretLLM
  : (await import('../src/ai/interpret.mock.js')).interpretMock;

let passed = 0, invariantViolations = 0, wrongWrites = 0;
const failures = [];

for (const c of cases) {
  const store = createStore();
  let nowMs = T0;
  const service = createLedgerService({ store, now: () => new Date(nowMs) });
  c.customers.forEach((x) => service.addCustomer(x));
  const agent = createAgent({ service, interpret });
  let session = agent.newSession();

  for (const step of c.steps) {
    if (step.newSession) session = agent.newSession();
    else if (step.clockDays) { nowMs = T0 + step.clockDays * 86_400_000; service.setDemoClock(new Date(nowMs).toISOString()); }
    else await session.handle(step.say);
  }

  const cust = service.findCustomers(c.expect.customer)[0];
  const { ledger } = service.getLedger(cust.id);
  const types = store.forCustomer(cust.id).map((e) => e.type);
  const actual = { balance: ledger.balance, status: ledger.status, disputedAmount: ledger.disputedAmount, eventTypes: types };
  const ok = actual.balance === c.expect.balance && actual.status === c.expect.status
    && actual.disputedAmount === c.expect.disputedAmount
    && JSON.stringify(types) === JSON.stringify(c.expect.eventTypes);
  const inv = checkInvariants(store.all(), new Date(nowMs));
  invariantViolations += inv.length;
  if (types.length > c.expect.eventTypes.length) wrongWrites++; // wrote something that should not exist
  if (ok) passed++; else failures.push({ id: c.id, expected: c.expect, actual });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id}`);
}

console.log(`\n${passed}/${cases.length} cases passed (final ledger-state accuracy ${((passed / cases.length) * 100).toFixed(0)}%)`);
console.log(`invariant violations: ${invariantViolations}   extra-write cases: ${wrongWrites}`);
if (failures.length) console.log('\nFailures:', JSON.stringify(failures, null, 2));
process.exit(failures.length ? 1 : 0);
