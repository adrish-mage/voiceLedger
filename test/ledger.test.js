import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ledger/store.js';
import { createLedgerService } from '../src/ledger/service.js';
import { replay, checkInvariants } from '../src/ledger/reducer.js';
import { createAgent } from '../src/agent.js';
import { interpretMock } from '../src/ai/interpret.mock.js';

const T0 = '2026-10-05T10:00:00.000Z';
const DAY = 86_400_000;

function setup({ term = 14 } = {}) {
  const store = createStore();
  const service = createLedgerService({ store, now: () => new Date(T0) });
  const raju = service.addCustomer({ name: 'Raju', defaultCreditTermDays: term });
  return { store, service, raju };
}
const commit = (service, res) => {
  assert.ok(res.ok, JSON.stringify(res));
  const a = service.approve(res.proposal.id, { digest: res.proposal.digest });
  assert.ok(a.ok, JSON.stringify(a));
  return a;
};
const credit800 = (service, raju) =>
  service.proposeCredit({ customerId: raju.id, amount: 800, items: [{ name: 'rice', totalAmount: 600 }, { name: 'oil', totalAmount: 200 }] });

test('credit then payment derives balance from the log', () => {
  const { service, raju } = setup();
  commit(service, credit800(service, raju));
  commit(service, service.proposePayment({ customerId: raju.id, amount: 300 }));
  assert.equal(service.getLedger(raju.id).ledger.balance, 500);
});

test('item-aware correction: 800 -> 720, original event untouched', () => {
  const { service, store, raju } = setup();
  commit(service, credit800(service, raju));
  const c = service.proposeCorrection({ customerId: raju.id, itemName: 'oil', newTotalAmount: 120, claimedOldTotal: 200 });
  assert.equal(c.proposal.display.delta, -80);
  commit(service, c);
  const evs = store.forCustomer(raju.id);
  assert.equal(evs[0].amount, 800);                 // E01 never changed
  assert.equal(evs[1].type, 'CORRECTION');
  assert.equal(evs[1].originalEventId, evs[0].id);
  assert.equal(service.getLedger(raju.id).ledger.balance, 720);
  assert.throws(() => { evs[0].amount = 1; }, TypeError); // frozen history
});

test('correction rejects a wrong "old" amount instead of guessing', () => {
  const { service, raju } = setup();
  commit(service, credit800(service, raju));
  const r = service.proposeCorrection({ customerId: raju.id, itemName: 'oil', newTotalAmount: 120, claimedOldTotal: 150 });
  assert.equal(r.code, 'OLD_AMOUNT_MISMATCH');
});

test('correction of a correction uses the latest effective items', () => {
  const { service, raju } = setup();
  commit(service, credit800(service, raju));
  commit(service, service.proposeCorrection({ customerId: raju.id, itemName: 'oil', newTotalAmount: 120 }));
  const second = service.proposeCorrection({ customerId: raju.id, itemName: 'oil', newTotalAmount: 100, claimedOldTotal: 120 });
  assert.equal(second.proposal.display.delta, -20);
  commit(service, second);
  assert.equal(service.getLedger(raju.id).ledger.balance, 700);
});

test('correction with no item breakdown / missing target fails safely', () => {
  const { service, raju } = setup();
  commit(service, service.proposeCredit({ customerId: raju.id, amount: 500 }));
  assert.equal(service.proposeCorrection({ customerId: raju.id, itemName: 'oil', newTotalAmount: 10 }).code, 'NO_CORRECTION_TARGET');
});

test('dispute never changes balance and never creates a payment', () => {
  const { service, store, raju } = setup();
  commit(service, credit800(service, raju));
  commit(service, service.proposeDispute({ customerId: raju.id, amount: 300 }));
  const { ledger } = service.getLedger(raju.id);
  assert.equal(ledger.balance, 800);
  assert.equal(ledger.disputedAmount, 300);
  assert.equal(ledger.status, 'DISPUTED');
  assert.equal(store.forCustomer(raju.id).filter((e) => e.type === 'PAYMENT_RECEIVED').length, 0);
});

test('dispute claim larger than the balance is refused', () => {
  const { service, raju } = setup();
  commit(service, credit800(service, raju));
  assert.equal(service.proposeDispute({ customerId: raju.id, amount: 900 }).code, 'CLAIM_EXCEEDS_BALANCE');
});

test('resolving a dispute: ACCEPT records a payment, REJECT does not', () => {
  for (const [outcome, expected] of [['ACCEPT_CLAIM', 500], ['REJECT_CLAIM', 800]]) {
    const { service, raju } = setup();
    commit(service, credit800(service, raju));
    commit(service, service.proposeDispute({ customerId: raju.id, amount: 300 }));
    const r = service.proposeResolveDispute({ customerId: raju.id, disputeId: 'D1', outcome });
    assert.equal(r.proposal.tier, 'FULL_APPROVAL');
    commit(service, r);
    const { ledger } = service.getLedger(raju.id);
    assert.equal(ledger.balance, expected);
    assert.equal(ledger.openDisputes.length, 0);
  }
});

test('FIFO: payment clears the oldest credit first; due date = earliest unpaid', () => {
  const { service, raju } = setup();
  commit(service, service.proposeCredit({ customerId: raju.id, amount: 500 }));
  service.setDemoClock(new Date(Date.parse(T0) + 5 * DAY).toISOString());
  commit(service, service.proposeCredit({ customerId: raju.id, amount: 300 }));
  commit(service, service.proposePayment({ customerId: raju.id, amount: 600 }));
  const { ledger } = service.getLedger(raju.id);
  assert.equal(ledger.credits[0].paid, 500);
  assert.equal(ledger.credits[1].paid, 100);
  assert.equal(ledger.balance, 200);
  assert.equal(ledger.dueDate, new Date(Date.parse(T0) + 19 * DAY).toISOString()); // 2nd credit's due date
});

test('overdue is computed from dates; disputed portion is excluded', () => {
  const { service, raju } = setup();
  commit(service, credit800(service, raju));
  assert.equal(service.getLedger(raju.id).ledger.isOverdue, false);
  service.setDemoClock(new Date(Date.parse(T0) + 15 * DAY).toISOString());
  let l = service.getLedger(raju.id).ledger;
  assert.equal(l.isOverdue, true);
  assert.equal(l.overdueEligibleAmount, 800);
  commit(service, service.proposeDispute({ customerId: raju.id, amount: 300 }));
  l = service.getLedger(raju.id).ledger;
  assert.equal(l.overdueEligibleAmount, 500);
  assert.equal(l.status, 'DISPUTED');
});

test('no default term => no invented due date', () => {
  const { service, raju } = setup({ term: null });
  const r = credit800(service, raju);
  assert.ok(r.proposal.warnings.includes('NO_DUE_DATE'));
  commit(service, r);
  service.setDemoClock(new Date(Date.parse(T0) + 400 * DAY).toISOString());
  assert.equal(service.getLedger(raju.id).ledger.isOverdue, false);
});

test('sessionOpen surfaces newly overdue accounts once', () => {
  const { service, raju } = setup();
  commit(service, credit800(service, raju));
  service.setDemoClock(new Date(Date.parse(T0) + 15 * DAY).toISOString());
  assert.equal(service.sessionOpen().overdue[0].newlyOverdue, true);
  assert.equal(service.sessionOpen().overdue[0].newlyOverdue, false);
});

test('approval gate: nothing is written without approve; FULL needs the right digest', () => {
  const { service, store, raju } = setup();
  commit(service, credit800(service, raju));
  const before = store.all().length;
  const c = service.proposeCorrection({ customerId: raju.id, itemName: 'oil', newTotalAmount: 120 });
  assert.equal(store.all().length, before);                       // proposal != event
  assert.equal(service.approve(c.proposal.id).code, 'DIGEST_REQUIRED');
  assert.equal(service.approve(c.proposal.id, { digest: 'wrong' }).code, 'DIGEST_MISMATCH');
  assert.equal(store.all().length, before);
  assert.ok(service.approve(c.proposal.id, { digest: c.proposal.digest }).ok);
  assert.equal(service.approve(c.proposal.id, { digest: c.proposal.digest }).code, 'NOT_PENDING'); // no double-commit
  assert.equal(store.all().length, before + 1);
});

test('stale proposal is refused when the ledger moved on', () => {
  const { service, raju } = setup();
  commit(service, credit800(service, raju));
  const a = service.proposePayment({ customerId: raju.id, amount: 100 });
  commit(service, service.proposePayment({ customerId: raju.id, amount: 50 }));
  assert.equal(service.approve(a.proposal.id, { digest: a.proposal.digest }).code, 'STALE_PROPOSAL');
});

test('validation: bad amounts, mismatched items', () => {
  const { service, raju } = setup();
  assert.equal(service.proposeCredit({ customerId: raju.id, amount: -5 }).code, 'BAD_AMOUNT');
  assert.equal(service.proposeCredit({ customerId: raju.id, amount: 100, items: [{ name: 'rice', totalAmount: 60 }] }).code, 'ITEMS_MISMATCH');
  assert.equal(service.proposePayment({ customerId: 'nope', amount: 5 }).code, 'NO_CUSTOMER');
});

// Property-style test: random operations must never break an invariant.
function prng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
test('random operations never violate ledger invariants', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rnd = prng(seed);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const { service, store, raju } = setup();
    const names = ['rice', 'oil', 'dal', 'sugar'];
    for (let i = 0; i < 120; i++) {
      const op = pick(['credit', 'credit', 'payment', 'correction', 'dispute', 'resolve']);
      let res;
      if (op === 'credit') {
        const items = names.slice(0, 1 + Math.floor(rnd() * 3)).map((n) => ({ name: n, totalAmount: 10 + Math.floor(rnd() * 200) }));
        res = service.proposeCredit({ customerId: raju.id, items });
      } else if (op === 'payment') res = service.proposePayment({ customerId: raju.id, amount: 1 + Math.floor(rnd() * 300) });
      else if (op === 'correction') res = service.proposeCorrection({ customerId: raju.id, itemName: pick(names), newTotalAmount: 1 + Math.floor(rnd() * 250) });
      else if (op === 'dispute') res = service.proposeDispute({ customerId: raju.id, amount: 1 + Math.floor(rnd() * 200) });
      else {
        const open = service.getLedger(raju.id).ledger.openDisputes[0];
        res = open ? service.proposeResolveDispute({ customerId: raju.id, disputeId: open.disputeId, outcome: pick(['ACCEPT_CLAIM', 'REJECT_CLAIM']) }) : { ok: false };
      }
      if (res.ok) service.approve(res.proposal.id, { digest: res.proposal.digest });
      assert.deepEqual(checkInvariants(store.all()), [], `seed ${seed} step ${i} op ${op}`);
      const l = replay(store.forCustomer(raju.id));
      assert.ok(l.disputedAmount <= l.outstandingCredit);
    }
  }
});

test('END TO END: the demo story through the agent', async () => {
  const { service, store, raju } = setup();
  const agent = createAgent({ service, interpret: interpretMock });
  let s = agent.newSession();
  const say = async (t) => s.handle(t);

  let r = await say('Raju ko 800 rupaye udhaar likh do, chawal 600 aur tel 200 ka.');
  assert.match(r.reply, /₹800/);
  assert.equal(store.all().length, 0);                    // read-back only, nothing written yet
  r = await say('Haan.');
  assert.equal(r.ledger.balance, 800);

  s = agent.newSession();                                 // new session, state from the ledger
  r = await say('Raju ka balance kya hai?');
  assert.match(r.reply, /₹800/);
  r = await say('Nahi, tel 200 nahi, 120 ka tha.');
  assert.equal(r.proposal.display.delta, -80);
  assert.equal(r.proposal.tier, 'FULL_APPROVAL');
  r = await say('Haan.');
  assert.equal(r.ledger.balance, 720);

  service.setDemoClock(new Date(Date.parse(T0) + 15 * DAY).toISOString());
  s = agent.newSession();
  assert.match(s.open().reply, /overdue/);                // proactive

  await say('Raju bol raha hai usne 300 rupaye de diye the.');
  r = await say('Haan.');
  assert.match(r.reply, /payment record nahi/);
  const { ledger } = service.getLedger(raju.id);
  assert.equal(ledger.balance, 720);
  assert.equal(ledger.status, 'DISPUTED');
  assert.equal(store.all().filter((e) => e.type === 'PAYMENT_RECEIVED').length, 0);
  assert.deepEqual(checkInvariants(store.all(), new Date(Date.parse(T0) + 15 * DAY)), []);
});
