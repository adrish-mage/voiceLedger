import { interpretLLM } from '../src/ai/interpret.llm.js';

const ctx = { customers: ['Raju', 'Amit', 'Suresh'], lastCustomer: 'Raju' };
for (const s of ['Raju ne 500 ka tel udhaar liya', 'haan', 'Suresh bol raha hai usne already de diya']) {
  console.log(s, '->', JSON.stringify(await interpretLLM(s, ctx)));
}