// The contract between the AI and the application.
// The LLM must return JSON of this shape. We validate it by hand (no trust).
// Anything that fails validation is treated as "didn't understand" - never executed.
export const INTENTS = [
  'RECORD_CREDIT', 'RECORD_PAYMENT', 'CORRECT_ITEM', 'OPEN_DISPUTE',
  'QUERY_BALANCE', 'QUERY_OVERDUE', 'CONFIRM', 'REJECT', 'UNKNOWN',
];

/*
Intent shape:
{
  intent: one of INTENTS,
  customerName: string | null,
  amount: integer | null,                       // rupees
  items: [{ name, quantity?, totalAmount }] | null,
  correction: { itemName, newTotalAmount, claimedOldTotal? } | null,
  dueDate: ISO string | null,
  language: 'hinglish' | 'hindi' | 'english',
  confidence: number 0..1,
  ambiguity: string | null                      // what was unclear, if anything
}
*/
export function validateIntent(x) {
  const errors = [];
  const isInt = (n) => Number.isInteger(n);
  if (!x || typeof x !== 'object') return { ok: false, errors: ['not an object'] };
  if (!INTENTS.includes(x.intent)) errors.push(`bad intent: ${x.intent}`);
  if (x.customerName != null && typeof x.customerName !== 'string') errors.push('customerName must be string|null');
  if (x.amount != null && !isInt(x.amount)) errors.push('amount must be integer|null');
  if (x.items != null) {
    if (!Array.isArray(x.items)) errors.push('items must be array|null');
    else x.items.forEach((i, n) => {
      if (typeof i?.name !== 'string' || !isInt(i?.totalAmount)) errors.push(`items[${n}] needs name + integer totalAmount`);
    });
  }
  if (x.correction != null) {
    const c = x.correction;
    if (typeof c?.itemName !== 'string' || !isInt(c?.newTotalAmount)) errors.push('correction needs itemName + integer newTotalAmount');
    if (c?.claimedOldTotal != null && !isInt(c.claimedOldTotal)) errors.push('claimedOldTotal must be integer');
  }
  if (typeof x.confidence !== 'number' || x.confidence < 0 || x.confidence > 1) errors.push('confidence must be 0..1');
  if (!['hinglish', 'hindi', 'english'].includes(x.language)) errors.push('bad language');
  return errors.length ? { ok: false, errors } : { ok: true, value: x };
}

export const emptyIntent = (over = {}) => ({
  intent: 'UNKNOWN', customerName: null, amount: null, items: null, correction: null,
  dueDate: null, language: 'hinglish', confidence: 0, ambiguity: null, ...over,
});
