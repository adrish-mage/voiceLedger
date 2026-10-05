// The application layer: the ONLY place events get written, and only via approve().
// Flow:  propose*()  ->  PENDING proposal (not a ledger event)
//        approve()   ->  validate + digest check -> append events
// The LLM / MCP layer can call propose*() and approve(). It cannot write events.
import { replay } from './reducer.js';
import { TIERS, tierFor, digestOf } from './approval.js';
import { validateCredit, validatePayment, validateDispute, err } from './validate.js';

const DAY = 86_400_000;
const inr = (n) => `₹${n}`;

export function createLedgerService({ store, now = () => new Date() }) {
  let demoClock = null; // DEMO CLOCK: show it on screen whenever this is set
  const clock = () => (demoClock ? new Date(demoClock) : now());
  const proposals = new Map();
  const overdueSeen = new Set();
  let proposalSeq = 0;
  let customerSeq = store.allCustomers().length;

  const events = (cid) => store.forCustomer(cid);
  const ledger = (cid, at = clock()) => replay(events(cid), at);

  const draft = (type, customerId, fields, meta = {}) => ({
    customerId, type, amount: 0, items: [], originalEventId: null, correction: null,
    disputeId: null, dueDate: null, resolution: null,
    occurredAt: clock().toISOString(), createdAt: clock().toISOString(),
    source: {
      channel: meta.channel ?? 'TEXT', transcript: meta.transcript ?? null,
      language: meta.language ?? null, speakerId: meta.speakerId ?? null,
    },
    proposal: { confidence: meta.confidence ?? null, extractedEntities: meta.extractedEntities ?? {} },
    ...fields,
  });

  function makeProposal({ kind, customerId, drafts, readBack, display = {}, warnings = [] }) {
    const p = {
      id: `P${++proposalSeq}`, kind, tier: tierFor(kind), customerId, drafts,
      digest: digestOf(drafts), baseVersion: events(customerId).length,
      status: 'PENDING', readBack, display, warnings, createdAt: clock().toISOString(),
    };
    proposals.set(p.id, p);
    return { ok: true, proposal: structuredClone(p) };
  }

  const needCustomer = (cid) => store.getCustomer(cid) ?? null;
  const nameOf = (cid) => store.getCustomer(cid).name;

  const service = {
    // ---------- clock ----------
    setDemoClock: (iso) => { demoClock = iso; },
    getClock: () => ({ now: clock().toISOString(), isDemoClock: Boolean(demoClock) }),

    // ---------- customers ----------
    addCustomer({ name, defaultCreditTermDays = null }) {
      const customer = { id: `C${++customerSeq}`, name: name.trim(), defaultCreditTermDays, createdAt: clock().toISOString() };
      store.putCustomer(customer);
      return customer;
    },
    // READ tier
    findCustomers(query) {
      const q = String(query ?? '').trim().toLowerCase();
      const all = store.allCustomers();
      const exact = all.filter((c) => c.name.toLowerCase() === q);
      if (exact.length) return exact;
      return all.filter((c) => c.name.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q));
    },
    listCustomerNames: () => store.allCustomers().map((c) => c.name),

    // ---------- reads (READ tier) ----------
    getLedger(customerId) {
      if (!needCustomer(customerId)) return err('NO_CUSTOMER', 'Unknown customer.');
      return { ok: true, customer: store.getCustomer(customerId), ledger: ledger(customerId) };
    },
    getAudit(customerId) {
      return events(customerId).map((e) => ({
        eventId: e.id, timestamp: e.occurredAt, type: e.type, originalEventId: e.originalEventId,
        approvalStatus: e.approval?.approved ? `APPROVED (${e.approval.tier})` : 'NONE',
        actor: 'USER',
        humanReadableSummary: summarize(e),
      }));
    },
    overdueAccounts() {
      return store.allCustomers()
        .map((c) => ({ customer: c, ledger: ledger(c.id) }))
        .filter((x) => x.ledger.isOverdue);
    },
    // Called when a session opens: proactive overdue surfacing.
    sessionOpen() {
      const list = service.overdueAccounts().map((x) => ({ ...x, newlyOverdue: !overdueSeen.has(x.customer.id) }));
      list.forEach((x) => overdueSeen.add(x.customer.id));
      return { ok: true, overdue: list, clock: service.getClock() };
    },

    // ---------- proposals (nothing is written yet) ----------
    proposeCredit({ customerId, amount, items, dueDate = null, meta = {} }) {
      if (!needCustomer(customerId)) return err('NO_CUSTOMER', 'Unknown customer.');
      const v = validateCredit({ amount, items });
      if (!v.ok) return v;
      const c = store.getCustomer(customerId);
      const warnings = [];
      let due = dueDate;
      if (!due && c.defaultCreditTermDays != null) due = new Date(clock().getTime() + c.defaultCreditTermDays * DAY).toISOString();
      if (!due) warnings.push('NO_DUE_DATE'); // we never invent a credit term
      const itemsText = v.items.length ? ', ' + v.items.map((i) => `${i.name} ${inr(i.totalAmount)}`).join(' aur ') : '';
      return makeProposal({
        kind: 'CREDIT', customerId, warnings,
        drafts: [draft('CREDIT_GIVEN', customerId, { amount: v.amount, items: v.items, dueDate: due }, meta)],
        readBack: `${c.name} ko ${inr(v.amount)} udhaar${itemsText}. Record kar doon?`,
        display: { customer: c.name, items: v.items, total: v.amount, dueDate: due },
      });
    },

    proposePayment({ customerId, amount, meta = {} }) {
      if (!needCustomer(customerId)) return err('NO_CUSTOMER', 'Unknown customer.');
      const v = validatePayment({ amount });
      if (!v.ok) return v;
      const warnings = amount > ledger(customerId).outstandingCredit ? ['OVERPAYMENT'] : [];
      return makeProposal({
        kind: 'PAYMENT', customerId, warnings,
        drafts: [draft('PAYMENT_RECEIVED', customerId, { amount }, meta)],
        readBack: `${nameOf(customerId)} se ${inr(amount)} payment mila. Record kar doon?`,
        display: { customer: nameOf(customerId), amount },
      });
    },

    // Item-aware correction. "tel 200 nahi, 120 ka tha"
    proposeCorrection({ customerId, itemName, newTotalAmount, claimedOldTotal = null, originalEventId = null, meta = {} }) {
      if (!needCustomer(customerId)) return err('NO_CUSTOMER', 'Unknown customer.');
      if (!Number.isInteger(newTotalAmount) || newTotalAmount < 0) return err('BAD_AMOUNT', 'Corrected amount must be a whole number of rupees.');
      const evs = events(customerId);
      const credits = evs.filter((e) => e.type === 'CREDIT_GIVEN');
      const itemKey = String(itemName).trim().toLowerCase();

      // Effective items = original items, or the latest correction's items
      const effectiveItems = (credit) => {
        const corr = evs.filter((e) => e.type === 'CORRECTION' && e.originalEventId === credit.id).at(-1);
        return corr ? corr.correction.correctedItems : credit.items;
      };
      let target = originalEventId
        ? credits.find((c) => c.id === originalEventId)
        : [...credits].reverse().find((c) => effectiveItems(c).some((i) => i.name === itemKey));
      if (!target) return err('NO_CORRECTION_TARGET', `Koi credit entry nahi mili jisme "${itemKey}" ho.`);
      if (!target.items.length) return err('NO_ITEM_BREAKDOWN', 'Is entry me items ka breakup nahi hai, isliye item-wise correction nahi ho sakta.');

      const before = effectiveItems(target);
      const matches = before.filter((i) => i.name === itemKey);
      if (matches.length === 0) return err('ITEM_NOT_FOUND', `"${itemKey}" is entry me nahi hai.`, { available: before.map((i) => i.name) });
      if (matches.length > 1) return err('AMBIGUOUS_ITEM', `"${itemKey}" ek se zyada baar hai.`);
      const oldItem = matches[0];
      if (claimedOldTotal != null && claimedOldTotal !== oldItem.totalAmount) {
        return err('OLD_AMOUNT_MISMATCH', `Aapne ${inr(claimedOldTotal)} kaha, par entry me ${itemKey} ${inr(oldItem.totalAmount)} hai.`, { recorded: oldItem.totalAmount });
      }
      const delta = newTotalAmount - oldItem.totalAmount;
      if (delta === 0) return err('NO_CHANGE', 'Amount pehle jaisa hi hai.');

      const after = before.map((i) =>
        i.name === itemKey ? { ...i, totalAmount: newTotalAmount, unitAmount: Math.round((newTotalAmount / i.quantity) * 100) / 100 } : i);
      const l = ledger(customerId);
      const newCreditTotal = after.reduce((s, i) => s + i.totalAmount, 0);
      return makeProposal({
        kind: 'CORRECTION', customerId,
        drafts: [draft('CORRECTION', customerId, {
          amount: delta, originalEventId: target.id,
          correction: { originalItems: before, correctedItems: after, amountDelta: delta },
        }, meta)],
        readBack: `${itemKey} ko ${inr(oldItem.totalAmount)} se ${inr(newTotalAmount)} karne par ${nameOf(customerId)} ka balance ${inr(l.balance)} se ${inr(l.balance + delta)} ho jayega. Correction approve karna hai?`,
        display: {
          customer: nameOf(customerId), originalEventId: target.id, before, after,
          delta, creditTotalBefore: before.reduce((s, i) => s + i.totalAmount, 0),
          creditTotalAfter: newCreditTotal, balanceBefore: l.balance, balanceAfter: l.balance + delta,
        },
      });
    },

    // "Raju bol raha hai usne 300 de diye the" -> DISPUTE, never a payment
    proposeDispute({ customerId, amount, meta = {} }) {
      if (!needCustomer(customerId)) return err('NO_CUSTOMER', 'Unknown customer.');
      const l = ledger(customerId);
      const v = validateDispute({ amount }, l.outstandingCredit);
      if (!v.ok) return v;
      const disputeId = `D${events(customerId).filter((e) => e.type === 'DISPUTE_OPENED').length + 1}`;
      return makeProposal({
        kind: 'DISPUTE_OPEN', customerId,
        drafts: [draft('DISPUTE_OPENED', customerId, { amount, disputeId }, meta)],
        readBack: `${nameOf(customerId)} ne ${inr(amount)} ka payment claim kiya hai. Main ise payment record nahi karunga, sirf dispute khol dun?`,
        display: { customer: nameOf(customerId), claimedAmount: amount, balanceUnchanged: l.balance },
      });
    },

    // outcome: 'ACCEPT_CLAIM' (records a payment + closes) | 'REJECT_CLAIM' (just closes)
    proposeResolveDispute({ customerId, disputeId, outcome, meta = {} }) {
      if (!needCustomer(customerId)) return err('NO_CUSTOMER', 'Unknown customer.');
      const d = ledger(customerId).openDisputes.find((x) => x.disputeId === disputeId);
      if (!d) return err('NO_OPEN_DISPUTE', 'Is naam ka koi khula dispute nahi hai.');
      if (!['ACCEPT_CLAIM', 'REJECT_CLAIM'].includes(outcome)) return err('BAD_OUTCOME', 'Outcome must be ACCEPT_CLAIM or REJECT_CLAIM.');
      const drafts = [];
      if (outcome === 'ACCEPT_CLAIM') drafts.push(draft('PAYMENT_RECEIVED', customerId, { amount: d.amount, disputeId }, meta));
      drafts.push(draft('DISPUTE_RESOLVED', customerId, { amount: d.amount, disputeId, resolution: outcome }, meta));
      const l = ledger(customerId);
      return makeProposal({
        kind: 'DISPUTE_RESOLVE', customerId, drafts,
        readBack: outcome === 'ACCEPT_CLAIM'
          ? `Ye ${inr(d.amount)} ko payment maan kar balance ${inr(l.balance)} se ${inr(l.balance - d.amount)} kar dega. Dispute band karun?`
          : `Claim reject karke dispute band hoga, balance ${inr(l.balance)} hi rahega. Theek hai?`,
        display: { customer: nameOf(customerId), outcome, amount: d.amount, balanceBefore: l.balance, balanceAfter: outcome === 'ACCEPT_CLAIM' ? l.balance - d.amount : l.balance },
      });
    },

    // ---------- the gate ----------
    approve(proposalId, { digest = null } = {}) {
      const p = proposals.get(proposalId);
      if (!p) return err('NO_PROPOSAL', 'Unknown proposal.');
      if (p.status !== 'PENDING') return err('NOT_PENDING', `Proposal is already ${p.status}.`);
      if (p.tier === TIERS.FULL_APPROVAL && !digest) return err('DIGEST_REQUIRED', 'Full approval must echo the proposal digest.');
      if (digest && digest !== p.digest) return err('DIGEST_MISMATCH', 'Approval does not match this proposal.');
      if (events(p.customerId).length !== p.baseVersion) {
        p.status = 'EXPIRED';
        return err('STALE_PROPOSAL', 'Ledger changed since this was proposed. Please ask again.');
      }
      const approval = { required: true, tier: p.tier, approved: true, approvedAt: clock().toISOString() };
      const final = p.drafts.map((d) => ({ ...structuredClone(d), approval }));

      // Invariant 7: committed content must equal approved content.
      if (digestOf(final) !== p.digest) throw new Error('INVARIANT 7: committed content differs from approved proposal');
      // Dry-run the replay so a bad event can never enter the log.
      try {
        replay([...events(p.customerId), ...final.map((e, i) => ({ ...e, id: `TMP${i}` }))], clock());
      } catch (x) {
        p.status = 'REJECTED';
        return err('INVARIANT_VIOLATION', x.message);
      }
      const written = store.append(final);
      p.status = 'COMMITTED';
      return { ok: true, events: written, ledger: ledger(p.customerId) };
    },
    reject(proposalId) {
      const p = proposals.get(proposalId);
      if (!p || p.status !== 'PENDING') return err('NOT_PENDING', 'Nothing to reject.');
      p.status = 'REJECTED';
      return { ok: true };
    },
  };
  return service;
}

function summarize(e) {
  switch (e.type) {
    case 'CREDIT_GIVEN': return `Credit given ₹${e.amount}` + (e.items.length ? ` (${e.items.map((i) => `${i.name} ₹${i.totalAmount}`).join(', ')})` : '');
    case 'PAYMENT_RECEIVED': return `Payment received ₹${e.amount}`;
    case 'CORRECTION': return `Correction ${e.correction.amountDelta > 0 ? '+' : '-'}₹${Math.abs(e.correction.amountDelta)} on ${e.originalEventId}`;
    case 'DISPUTE_OPENED': return `Dispute opened: customer claims ₹${e.amount} paid (balance unchanged)`;
    case 'DISPUTE_RESOLVED': return `Dispute resolved: ${e.resolution}`;
    default: return e.type;
  }
}
