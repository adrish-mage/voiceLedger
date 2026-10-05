// Approval tiers + the digest that binds an approval to EXACT content.
import { createHash } from 'node:crypto';

export const TIERS = Object.freeze({
  READ: 'READ',                   // no write at all
  QUICK_CONFIRM: 'QUICK_CONFIRM', // read-back + "haan"
  FULL_APPROVAL: 'FULL_APPROVAL', // must echo the proposal digest (shown before/after)
});

const TIER_BY_KIND = Object.freeze({
  CREDIT: TIERS.QUICK_CONFIRM,
  PAYMENT: TIERS.QUICK_CONFIRM,
  DISPUTE_OPEN: TIERS.QUICK_CONFIRM,
  CORRECTION: TIERS.FULL_APPROVAL,
  DISPUTE_RESOLVE: TIERS.FULL_APPROVAL,
});
export const tierFor = (kind) => {
  const t = TIER_BY_KIND[kind];
  if (!t) throw new Error(`No approval tier defined for kind ${kind}`);
  return t;
};

// Only the financially meaningful fields go into the digest.
// Invariant 7: what gets committed must hash to what was approved.
const core = (e) => ({
  customerId: e.customerId, type: e.type, amount: e.amount, items: e.items,
  originalEventId: e.originalEventId, correction: e.correction,
  disputeId: e.disputeId, dueDate: e.dueDate, resolution: e.resolution ?? null,
});
const stable = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x);

export const digestOf = (events) =>
  createHash('sha256').update(stable(events.map(core))).digest('hex').slice(0, 12);
