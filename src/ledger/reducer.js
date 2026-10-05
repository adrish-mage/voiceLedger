// THE heart of the project. Pure function: events in -> customer view out.
// Balance is NEVER stored. It is always derived by replaying the log.
//
// Rules (see README "Ledger invariants"):
//  CREDIT_GIVEN   +amount          PAYMENT_RECEIVED  -amount
//  CORRECTION     +correction.amountDelta (on an existing credit)
//  DISPUTE_*      contribute 0 to the balance, ever
//  Payments are allocated FIFO (oldest unpaid credit first).
//  Overdue is computed here from dates. The LLM never decides it.

export const EVENT_TYPES = ['CREDIT_GIVEN', 'PAYMENT_RECEIVED', 'CORRECTION', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED'];

const violation = (msg) => new Error(`INVARIANT: ${msg}`);

export function replay(events, now = new Date()) {
  const credits = [];            // oldest first (append order)
  const creditById = new Map();
  const disputes = new Map();
  const seen = new Set();
  let paymentsTotal = 0;

  for (const e of events) {
    if (seen.has(e.id)) throw violation(`duplicate event id ${e.id}`);
    seen.add(e.id);
    switch (e.type) {
      case 'CREDIT_GIVEN': {
        const c = { eventId: e.id, amount: e.amount, paid: 0, dueDate: e.dueDate ?? null };
        credits.push(c);
        creditById.set(e.id, c);
        break;
      }
      case 'PAYMENT_RECEIVED':
        paymentsTotal += e.amount;
        break;
      case 'CORRECTION': {
        const target = creditById.get(e.originalEventId);
        if (!target) throw violation(`correction ${e.id} references missing credit ${e.originalEventId}`);
        target.amount += e.correction.amountDelta;
        if (target.amount < 0) throw violation(`correction ${e.id} makes credit ${target.eventId} negative`);
        break;
      }
      case 'DISPUTE_OPENED':
        disputes.set(e.disputeId, { disputeId: e.disputeId, amount: e.amount, status: 'OPEN', openedBy: e.id });
        break;
      case 'DISPUTE_RESOLVED': {
        const d = disputes.get(e.disputeId);
        if (!d) throw violation(`resolution ${e.id} references missing dispute ${e.disputeId}`);
        d.status = 'RESOLVED';
        d.resolvedBy = e.id;
        break;
      }
      default:
        throw violation(`unknown event type ${e.type}`);
    }
  }

  // FIFO payment allocation
  let remaining = paymentsTotal;
  for (const c of credits) {
    c.paid = Math.min(c.amount, remaining);
    remaining -= c.paid;
  }
  const unallocatedPayment = remaining; // customer overpaid
  const outstandingCredit = credits.reduce((s, c) => s + (c.amount - c.paid), 0);

  // Two independent ways to compute the balance. They must agree (Invariant 1).
  const balance = outstandingCredit - unallocatedPayment;
  const balanceByFormula = events.reduce(
    (s, e) =>
      s + (e.type === 'CREDIT_GIVEN' ? e.amount
        : e.type === 'PAYMENT_RECEIVED' ? -e.amount
        : e.type === 'CORRECTION' ? e.correction.amountDelta : 0), 0);
  if (balance !== balanceByFormula) throw violation(`balance ${balance} != formula ${balanceByFormula}`);

  const openDisputes = [...disputes.values()].filter((d) => d.status === 'OPEN');
  const disputedAmount = Math.min(openDisputes.reduce((s, d) => s + d.amount, 0), outstandingCredit);

  const unpaid = credits.filter((c) => c.amount - c.paid > 0);
  const dated = unpaid.filter((c) => c.dueDate).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const dueDate = dated[0]?.dueDate ?? null;
  const pastDue = unpaid
    .filter((c) => c.dueDate && new Date(c.dueDate) < now)
    .reduce((s, c) => s + (c.amount - c.paid), 0);
  const overdueEligibleAmount = Math.max(pastDue - disputedAmount, 0);

  // Status priority: DISPUTED (needs a human) > OVERDUE > OUTSTANDING > CLEAR
  const status = openDisputes.length ? 'DISPUTED'
    : overdueEligibleAmount > 0 ? 'OVERDUE'
    : outstandingCredit > 0 ? 'OUTSTANDING' : 'CLEAR';

  return {
    balance, outstandingCredit, unallocatedPayment,
    disputedAmount, openDisputes, status,
    isOverdue: overdueEligibleAmount > 0, overdueEligibleAmount, dueDate,
    lastTransactionAt: events.at(-1)?.occurredAt ?? null,
    transactionCount: events.length,
    credits: credits.map((c) => ({ ...c })),
  };
}

// Run after anything risky (and in tests). Empty array = healthy.
export function checkInvariants(events, now = new Date()) {
  const problems = [];
  events.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`seq gap at ${e.id}`);
    if (!Object.isFrozen(e)) problems.push(`${e.id} is not frozen (mutable history)`);
    if (['CREDIT_GIVEN', 'PAYMENT_RECEIVED', 'CORRECTION'].includes(e.type) && !e.approval?.approved) {
      problems.push(`${e.id} is a financial event without approval`);
    }
  });
  const byCustomer = Map.groupBy(events, (e) => e.customerId);
  for (const [, evs] of byCustomer) {
    try { replay(evs, now); } catch (x) { problems.push(x.message); }
  }
  return problems;
}
