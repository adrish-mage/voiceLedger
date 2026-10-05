// Pure validation. The LLM never gets to skip these checks.
export const isMoney = (n) => Number.isInteger(n) && n > 0; // whole rupees for now

export const err = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export function normalizeItems(items) {
  return (items ?? []).map((i) => {
    const quantity = i.quantity ?? 1;
    return {
      name: String(i.name).trim().toLowerCase(),
      quantity,
      unitAmount: Math.round((i.totalAmount / quantity) * 100) / 100,
      totalAmount: i.totalAmount,
    };
  });
}

// Returns {ok:true, amount, items} or an error object.
export function validateCredit({ amount, items }) {
  const norm = normalizeItems(items);
  for (const i of norm) {
    if (!Number.isInteger(i.totalAmount) || i.totalAmount <= 0 || !(i.quantity > 0)) {
      return err('BAD_ITEM', `Item "${i.name}" needs a positive whole-rupee amount.`);
    }
  }
  const sum = norm.reduce((s, i) => s + i.totalAmount, 0);
  const total = amount ?? (norm.length ? sum : null);
  if (!isMoney(total)) return err('BAD_AMOUNT', 'Amount must be a positive whole number of rupees.');
  if (norm.length && sum !== total) {
    return err('ITEMS_MISMATCH', `Items add up to ${sum} but total is ${total}.`, { itemsTotal: sum, total });
  }
  return { ok: true, amount: total, items: norm };
}

export function validatePayment({ amount }) {
  return isMoney(amount) ? { ok: true, amount } : err('BAD_AMOUNT', 'Payment must be a positive whole number of rupees.');
}

export function validateDispute({ amount }, outstanding) {
  if (!isMoney(amount)) return err('BAD_AMOUNT', 'Disputed amount must be a positive whole number of rupees.');
  if (amount > outstanding) {
    return err('CLAIM_EXCEEDS_BALANCE', `Claim of ${amount} is more than the outstanding ${outstanding}.`, { outstanding });
  }
  return { ok: true, amount };
}
