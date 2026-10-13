// The application layer: the ONLY place events get written, and only via approve().
// Flow:  propose*()  ->  PENDING proposal (not a ledger event)
//        approve()   ->  validate + digest check -> append events
// The LLM / MCP layer can call propose*() and approve(). It cannot write events.
import { replay } from './reducer.js';
import { TIERS, tierFor, digestOf } from './approval.js';
import { validateCredit, validatePayment, validateDispute } from './validate.js';
import { render, formatMoney } from '../i18n/messages.js';

const DAY = 86_400_000;

export function createLedgerService({ store, now = () => new Date(), currency = process.env.CURRENCY || 'INR' }) {
  const shopCurrency = String(currency).toUpperCase();
  const money = (amount, lang = 'en') => formatMoney(amount, shopCurrency, lang);
  const message = (key, params, lang = 'en') => render(key, params, lang);
  const errorFor = (code, params = {}, lang = 'en', extra = {}) => ({
    ok: false, code, message: message(code, params, lang), ...extra,
  });
  const validationError = (result, lang, amountKey, amount) => {
    if (result.code === 'BAD_ITEM') return errorFor('badItem', {}, lang, { code: result.code });
    if (result.code === 'BAD_AMOUNT') return errorFor(amountKey, {}, lang, { code: result.code });
    if (result.code === 'ITEMS_MISMATCH') return errorFor('itemsMismatch', {
      itemsTotal: money(result.itemsTotal, lang), total: money(result.total, lang),
    }, lang, { code: result.code, itemsTotal: result.itemsTotal, total: result.total });
    if (result.code === 'CLAIM_EXCEEDS_BALANCE') return errorFor('claimExceedsBalance', {
      amount: money(amount, lang), outstanding: money(result.outstanding, lang),
    }, lang, { code: result.code, outstanding: result.outstanding });
    return result;
  };
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

  function makeProposal({ kind, customerId, drafts, readBack, display = {}, warnings = [], lang = 'en' }) {
    const p = {
      id: `P${++proposalSeq}`, kind, tier: tierFor(kind), customerId, drafts,
      digest: digestOf(drafts), baseVersion: events(customerId).length,
      status: 'PENDING', readBack, display, warnings, lang, createdAt: clock().toISOString(),
    };
    proposals.set(p.id, p);
    const { lang: _lang, ...publicProposal } = p;
    return { ok: true, proposal: structuredClone(publicProposal) };
  }

  const needCustomer = (cid) => store.getCustomer(cid) ?? null;
  const nameOf = (cid) => store.getCustomer(cid).name;

  const service = {
    currency: shopCurrency,
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
    getLedger(customerId, { lang = 'en' } = {}) {
      if (!needCustomer(customerId)) return errorFor('unknownCustomer', {}, lang, { code: 'NO_CUSTOMER' });
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
      const lang = meta.lang ?? 'en';
      if (!needCustomer(customerId)) return errorFor('unknownCustomer', {}, lang, { code: 'NO_CUSTOMER' });
      const v = validateCredit({ amount, items });
      if (!v.ok) return validationError(v, lang, 'badCreditAmount');
      const c = store.getCustomer(customerId);
      const warnings = [];
      let due = dueDate;
      if (!due && c.defaultCreditTermDays != null) due = new Date(clock().getTime() + c.defaultCreditTermDays * DAY).toISOString();
      if (!due) warnings.push('NO_DUE_DATE'); // we never invent a credit term
      const itemsText = v.items.length ? ', ' + v.items.map((i) => message('itemEntry', { name: i.name, amount: money(i.totalAmount, lang) }, lang)).join(message('itemJoiner', {}, lang)) : '';
      return makeProposal({
        kind: 'CREDIT', customerId, warnings, lang,
        drafts: [draft('CREDIT_GIVEN', customerId, { amount: v.amount, items: v.items, dueDate: due }, meta)],
        readBack: message('creditReadBack', { customer: c.name, amount: money(v.amount, lang), items: itemsText }, lang),
        display: { customer: c.name, items: v.items, total: v.amount, dueDate: due },
      });
    },

    proposePayment({ customerId, amount, meta = {} }) {
      const lang = meta.lang ?? 'en';
      if (!needCustomer(customerId)) return errorFor('unknownCustomer', {}, lang, { code: 'NO_CUSTOMER' });
      const v = validatePayment({ amount });
      if (!v.ok) return validationError(v, lang, 'badPaymentAmount');
      const warnings = amount > ledger(customerId).outstandingCredit ? ['OVERPAYMENT'] : [];
      return makeProposal({
        kind: 'PAYMENT', customerId, warnings, lang,
        drafts: [draft('PAYMENT_RECEIVED', customerId, { amount }, meta)],
        readBack: message('paymentReadBack', { customer: nameOf(customerId), amount: money(amount, lang) }, lang),
        display: { customer: nameOf(customerId), amount },
      });
    },

    // Item-aware correction. "tel 200 nahi, 120 ka tha"
    proposeCorrection({ customerId, itemName, newTotalAmount, claimedOldTotal = null, originalEventId = null, meta = {} }) {
      const lang = meta.lang ?? 'en';
      if (!needCustomer(customerId)) return errorFor('unknownCustomer', {}, lang, { code: 'NO_CUSTOMER' });
      if (!Number.isInteger(newTotalAmount) || newTotalAmount < 0) return errorFor('badCorrectionAmount', {}, lang, { code: 'BAD_AMOUNT' });
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
      if (!target) return errorFor('noCorrectionTarget', { item: itemKey }, lang, { code: 'NO_CORRECTION_TARGET' });
      if (!target.items.length) return errorFor('noItemBreakdown', {}, lang, { code: 'NO_ITEM_BREAKDOWN' });

      const before = effectiveItems(target);
      const matches = before.filter((i) => i.name === itemKey);
      if (matches.length === 0) return errorFor('itemNotFound', { item: itemKey }, lang, { code: 'ITEM_NOT_FOUND', available: before.map((i) => i.name) });
      if (matches.length > 1) return errorFor('ambiguousItem', { item: itemKey }, lang, { code: 'AMBIGUOUS_ITEM' });
      const oldItem = matches[0];
      if (claimedOldTotal != null && claimedOldTotal !== oldItem.totalAmount) {
        return errorFor('oldAmountMismatch', { claimed: money(claimedOldTotal, lang), item: itemKey, recorded: money(oldItem.totalAmount, lang) }, lang, { code: 'OLD_AMOUNT_MISMATCH', recorded: oldItem.totalAmount });
      }
      const delta = newTotalAmount - oldItem.totalAmount;
      if (delta === 0) return errorFor('noChange', {}, lang, { code: 'NO_CHANGE' });

      const after = before.map((i) =>
        i.name === itemKey ? { ...i, totalAmount: newTotalAmount, unitAmount: Math.round((newTotalAmount / i.quantity) * 100) / 100 } : i);
      const l = ledger(customerId);
      const newCreditTotal = after.reduce((s, i) => s + i.totalAmount, 0);
      return makeProposal({
        kind: 'CORRECTION', customerId, lang,
        drafts: [draft('CORRECTION', customerId, {
          amount: delta, originalEventId: target.id,
          correction: { originalItems: before, correctedItems: after, amountDelta: delta },
        }, meta)],
        readBack: message('correctionReadBack', { item: itemKey, oldAmount: money(oldItem.totalAmount, lang), newAmount: money(newTotalAmount, lang), customer: nameOf(customerId), before: money(l.balance, lang), after: money(l.balance + delta, lang) }, lang),
        display: {
          customer: nameOf(customerId), originalEventId: target.id, before, after,
          delta, creditTotalBefore: before.reduce((s, i) => s + i.totalAmount, 0),
          creditTotalAfter: newCreditTotal, balanceBefore: l.balance, balanceAfter: l.balance + delta,
        },
      });
    },

    // "Raju bol raha hai usne 300 de diye the" -> DISPUTE, never a payment
    proposeDispute({ customerId, amount, meta = {} }) {
      const lang = meta.lang ?? 'en';
      if (!needCustomer(customerId)) return errorFor('unknownCustomer', {}, lang, { code: 'NO_CUSTOMER' });
      const l = ledger(customerId);
      const v = validateDispute({ amount }, l.outstandingCredit);
      if (!v.ok) return validationError(v, lang, 'badDisputeAmount', amount);
      const disputeId = `D${events(customerId).filter((e) => e.type === 'DISPUTE_OPENED').length + 1}`;
      return makeProposal({
        kind: 'DISPUTE_OPEN', customerId, lang,
        drafts: [draft('DISPUTE_OPENED', customerId, { amount, disputeId }, meta)],
        readBack: message('disputeReadBack', { customer: nameOf(customerId), amount: money(amount, lang) }, lang),
        display: { customer: nameOf(customerId), claimedAmount: amount, balanceUnchanged: l.balance },
      });
    },

    // outcome: 'ACCEPT_CLAIM' (records a payment + closes) | 'REJECT_CLAIM' (just closes)
    proposeResolveDispute({ customerId, disputeId, outcome, meta = {} }) {
      const lang = meta.lang ?? 'en';
      if (!needCustomer(customerId)) return errorFor('unknownCustomer', {}, lang, { code: 'NO_CUSTOMER' });
      const d = ledger(customerId).openDisputes.find((x) => x.disputeId === disputeId);
      if (!d) return errorFor('noOpenDispute', {}, lang, { code: 'NO_OPEN_DISPUTE' });
      if (!['ACCEPT_CLAIM', 'REJECT_CLAIM'].includes(outcome)) return errorFor('badOutcome', {}, lang, { code: 'BAD_OUTCOME' });
      const drafts = [];
      if (outcome === 'ACCEPT_CLAIM') drafts.push(draft('PAYMENT_RECEIVED', customerId, { amount: d.amount, disputeId }, meta));
      drafts.push(draft('DISPUTE_RESOLVED', customerId, { amount: d.amount, disputeId, resolution: outcome }, meta));
      const l = ledger(customerId);
      return makeProposal({
        kind: 'DISPUTE_RESOLVE', customerId, drafts, lang,
        readBack: outcome === 'ACCEPT_CLAIM'
          ? message('resolveAcceptReadBack', { amount: money(d.amount, lang), before: money(l.balance, lang), after: money(l.balance - d.amount, lang) }, lang)
          : message('resolveRejectReadBack', { balance: money(l.balance, lang) }, lang),
        display: { customer: nameOf(customerId), outcome, amount: d.amount, balanceBefore: l.balance, balanceAfter: outcome === 'ACCEPT_CLAIM' ? l.balance - d.amount : l.balance },
      });
    },

    // ---------- the gate ----------
    approve(proposalId, { digest = null, lang: requestedLang = 'en' } = {}) {
      const p = proposals.get(proposalId);
      if (!p) return errorFor('noProposal', {}, requestedLang, { code: 'NO_PROPOSAL' });
      const lang = p.lang ?? 'en';
      if (p.status !== 'PENDING') return errorFor('notPending', { status: p.status }, lang, { code: 'NOT_PENDING' });
      if (p.tier === TIERS.FULL_APPROVAL && !digest) return errorFor('digestRequired', {}, lang, { code: 'DIGEST_REQUIRED' });
      if (digest && digest !== p.digest) return errorFor('digestMismatch', {}, lang, { code: 'DIGEST_MISMATCH' });
      if (events(p.customerId).length !== p.baseVersion) {
        p.status = 'EXPIRED';
        return errorFor('staleProposal', {}, lang, { code: 'STALE_PROPOSAL' });
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
        return errorFor('invariantViolation', {}, lang, { code: 'INVARIANT_VIOLATION' });
      }
      const written = store.append(final);
      p.status = 'COMMITTED';
      return { ok: true, events: written, ledger: ledger(p.customerId) };
    },
    reject(proposalId, { lang = 'en' } = {}) {
      const p = proposals.get(proposalId);
      if (!p || p.status !== 'PENDING') return errorFor('nothingToReject', {}, p?.lang ?? lang, { code: 'NOT_PENDING' });
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
