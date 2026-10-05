// Runs the whole demo story through the real pipeline (mock interpreter, no AI).
//   npm run demo
import { createStore } from '../src/ledger/store.js';
import { createLedgerService } from '../src/ledger/service.js';
import { createAgent } from '../src/agent.js';
import { interpretMock } from '../src/ai/interpret.mock.js';

const store = createStore();
const service = createLedgerService({ store });
service.addCustomer({ name: 'Raju', defaultCreditTermDays: 14 });
const agent = createAgent({ service, interpret: interpretMock });

let s = agent.newSession();
const say = async (t) => {
  const r = await s.handle(t);
  console.log(`\nYOU   : ${t}\nAGENT : ${r.reply}`);
  return r;
};

await say('Raju ko 800 rupaye udhaar likh do, chawal 600 aur tel 200 ka.');
await say('Haan.');

s = agent.newSession(); // new session: state comes from the ledger, not memory
await say('Raju ka balance kya hai?');
await say('Nahi, tel 200 nahi, 120 ka tha.');
await say('Haan.');

service.setDemoClock(new Date(Date.now() + 15 * 86_400_000).toISOString());
console.log('\n*** DEMO CLOCK ACTIVE ***');
s = agent.newSession();
console.log('AGENT (proactive on open):', s.open().reply);

await say('Raju bol raha hai usne 300 rupaye de diye the.');
await say('Haan.');

const raju = service.findCustomers('Raju')[0];
console.log('\n--- AUDIT TRAIL ---');
service.getAudit(raju.id).forEach((a) => console.log(`${a.eventId}  ${a.type.padEnd(17)} ${a.humanReadableSummary}`));
const { ledger } = service.getLedger(raju.id);
console.log('\n--- DERIVED STATE ---');
console.log({ balance: ledger.balance, status: ledger.status, disputed: ledger.disputedAmount, overdueEligible: ledger.overdueEligibleAmount });
