// WHERE THE REAL AI GOES (Day 2). Everything else in the app is already built.
//
// What "AI integration" means here, in one sentence:
//   send the transcript + some context to a model, get back JSON that matches
//   schema.js, then let the application validate it. That's it.
//
// Steps to finish this file:
//  1. Pick a provider (Bedrock is the AWS-friendly choice for the hackathon bonus).
//  2. Implement callModel(messages) below using that provider's SDK.
//  3. Ask the model to return ONLY JSON (most providers have a JSON / tool-use mode).
//  4. Parse -> validateIntent() -> on failure retry once, then return UNKNOWN.
//  5. Run `npm run eval` and compare against interpret.mock.js.
//
// Rules for the model (these are in the prompt AND enforced in code):
//  - It interprets; it never decides balances, overdue, or approvals.
//  - It never invents a customer, amount, or item. Unclear -> ambiguity field.
import { validateIntent, emptyIntent } from './schema.js';
import { ITEM_ALIASES } from './lexicon.js';

export const SYSTEM_PROMPT = `You convert a shopkeeper's spoken Hinglish/Hindi/English sentence into JSON.
Return ONLY a JSON object with these fields:
intent: RECORD_CREDIT | RECORD_PAYMENT | CORRECT_ITEM | OPEN_DISPUTE | QUERY_BALANCE | QUERY_OVERDUE | CONFIRM | REJECT | UNKNOWN
customerName: string or null (must be one of the known customers, else null)
amount: integer rupees or null
items: [{name, quantity, totalAmount}] or null
correction: {itemName, newTotalAmount, claimedOldTotal} or null
dueDate: ISO date or null (only if the speaker stated one)
language: hinglish | hindi | english
confidence: number 0..1
ambiguity: short string describing anything unclear, else null

Hard rules:
- A customer SAYING they already paid is OPEN_DISPUTE, never RECORD_PAYMENT.
- "nahi, X nahi, Y tha" is CORRECT_ITEM with claimedOldTotal=X and newTotalAmount=Y.
- Bare "haan"/"yes" is CONFIRM, bare "nahi"/"no" is REJECT.
- If a name, amount or item is unclear, set it to null and explain in ambiguity. Never guess.
- Never compute balances, totals owed, or due dates yourself.`;

export function buildMessages(transcript, { customers = [], lastCustomer = null } = {}) {
  const itemWords = Object.entries(ITEM_ALIASES).map(([c, w]) => `${c}: ${w.join('/')}`).join('; ');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Known customers: ${customers.join(', ') || '(none)'}\nMost recent customer in this conversation: ${lastCustomer ?? '(none)'}\nKnown items (canonical: spoken forms): ${itemWords}\n\nSentence: ${transcript}`,
    },
  ];
}

// TODO(Day 2): implement with your chosen provider. Must resolve to a JSON string.
async function callModel(/* messages */) {
  throw new Error('callModel not implemented yet - pick a provider (see steps at top of file)');
}

export async function interpretLLM(transcript, context) {
  const messages = buildMessages(transcript, context);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callModel(messages);
      const json = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
      const checked = validateIntent(json);
      if (checked.ok) return checked.value;
    } catch (e) {
      if (String(e.message).includes('not implemented')) throw e;
    }
  }
  return emptyIntent({ ambiguity: 'model output failed validation twice' });
}
