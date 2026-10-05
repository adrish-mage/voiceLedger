// Orchestrator: transcript -> interpret -> validate -> propose -> (user says haan) -> approve.
// The agent holds conversation state (who are we talking about? what's pending?).
// It can only call service.propose*/approve/reject. It has no way to write events.
import { validateIntent } from './ai/schema.js';
import { canonicalItem } from './ai/lexicon.js';

const inr = (n) => `₹${n}`;

export function createAgent({ service, interpret }) {
    return {
        newSession() {
            const ctx = { customerId: null, pending: null }; // initial / default id and whether there is a pending confirmation
            const nameOf = (cid) => service.getLedger(cid).customer.name; // gets customer id

            const resolveCustomer = (name) => {
                if (!name) {
                    return ctx.customerId ? { ok: true, id: ctx.customerId } : { ok: false, reply: 'Kis customer ke liye?' };
                }
                const found = service.findCustomers(name);
                if (found.length === 0) return { ok: false, reply: `"${name}" naam ka customer nahi mila.` };
                if (found.length > 1) return { ok: false, reply: `Kaun sa ${name}? ${found.map((c) => c.name).join(' ya ')}?` };
                return { ok: true, id: found[0].id };
            };

            const setPending = (res) => {
                if (!res.ok) return { reply: res.message, error: res };
                if (ctx.pending) service.reject(ctx.pending.id); // a new request replaces the old one
                ctx.pending = {
                    id: res.proposal.id, // proposal ID
                    digest: res.proposal.digest, // proposal fingerprint/digest
                    kind: res.proposal.kind, // what kind of action
                    customerId: res.proposal.customerId, // which customer
                    display: res.proposal.display // what to display
                };         
                return { reply: res.proposal.readBack, proposal: res.proposal };
            };

            const balanceLine = (cid) => {
                const { customer, ledger: l } = service.getLedger(cid);
                if (l.status === 'CLEAR') return `${customer.name} ka koi balance baaki nahi hai.`;
                let s = `${customer.name} ka outstanding balance ${inr(l.balance)} hai.`;
                if (l.disputedAmount) s += ` Isme ${inr(l.disputedAmount)} dispute me hai.`;
                if (l.isOverdue) s += ' Ye overdue hai.';
                return s;
            };

            return {
                ctx,
                // Proactive: call when a session starts (Alexa-style "good morning" briefing)
                open() {
                    const s = service.sessionOpen();
                    const lines = s.overdue.filter((x) => x.newlyOverdue).map((x) =>
                        `${x.customer.name} ka credit overdue hai. Outstanding ${inr(x.ledger.overdueEligibleAmount)} hai.`);
                    return { reply: lines.join(' ') || null, overdue: s.overdue, clock: s.clock };
                },

                async handle(transcript, meta = {}) {
                    const raw = await interpret(transcript, { // calls the AI
                        customers: service.listCustomerNames(),
                        lastCustomer: ctx.customerId ? nameOf(ctx.customerId) : null,
                    });
                    const checked = validateIntent(raw);
                    if (!checked.ok) return { reply: 'Samajh nahi aaya, dobara bolo?', intent: null, errors: checked.errors };
                    const intent = checked.value;
                    const m = {
                        channel: meta.channel ?? 'TEXT', transcript, language: intent.language,
                        speakerId: meta.speakerId ?? null, confidence: intent.confidence, extractedEntities: intent,
                    };
                    const out = (o) => ({ intent, ...o });

                    if (intent.intent === 'UNKNOWN') return out({ reply: 'Samajh nahi aaya, dobara bolo?' });
                    const writes = ['RECORD_CREDIT', 'RECORD_PAYMENT', 'CORRECT_ITEM', 'OPEN_DISPUTE'];
                    if (writes.includes(intent.intent) && intent.confidence < 0.6) {
                        return out({ reply: 'Pakka samajh nahi aaya. Dobara bolenge?' }); // never write on low confidence
                    }

                    switch (intent.intent) {
                        case 'CONFIRM': {
                            if (!ctx.pending) return out({ reply: 'Abhi confirm karne ko kuch nahi hai.' });
                            // The UI must have SHOWN the proposal before the user said "haan".
                            // The digest ties this yes to exactly that proposal.
                            const p = ctx.pending;
                            const res = service.approve(p.id, { digest: p.digest });
                            if (!res.ok) { ctx.pending = null; return out({ reply: res.message, error: res }); }
                            ctx.pending = null;
                            const l = res.ledger;
                            const name = nameOf(p.customerId);
                            const lines = {
                                CREDIT: `Record ho gaya. ${name} ka balance ${inr(l.balance)} hai.`,
                                PAYMENT: `Payment record ho gaya. ${name} ka balance ${inr(l.balance)} hai.`,
                                CORRECTION: `Correction lag gayi. ${name} ka balance ab ${inr(l.balance)} hai.`,
                                DISPUTE_OPEN: `${name} ne dispute kiya hai. Maine ise payment record nahi kiya. Balance ${inr(l.balance)} hi hai.`,
                                DISPUTE_RESOLVE: `Dispute band ho gaya. ${name} ka balance ${inr(l.balance)} hai.`,
                            };
                            return out({ reply: lines[p.kind], committed: res.events, ledger: l });
                        }
                        case 'REJECT': {
                            if (!ctx.pending) return out({ reply: 'Theek hai.' });
                            service.reject(ctx.pending.id);
                            ctx.pending = null;
                            return out({ reply: 'Theek hai, cancel kar diya.' });
                        }
                        case 'QUERY_BALANCE': {
                            const r = resolveCustomer(intent.customerName);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            return out({ reply: balanceLine(r.id), ledger: service.getLedger(r.id).ledger });
                        }
                        case 'QUERY_OVERDUE': {
                            const list = service.overdueAccounts();
                            if (!list.length) return out({ reply: 'Koi account overdue nahi hai.' });
                            return out({ reply: list.map((x) => `${x.customer.name}: ${inr(x.ledger.overdueEligibleAmount)} overdue`).join(', ') + '.' });
                        }
                        case 'RECORD_CREDIT': {
                            const r = resolveCustomer(intent.customerName);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            const items = (intent.items ?? []).map((i) => ({ ...i, name: canonicalItem(i.name) ?? i.name }));
                            return out(setPending(service.proposeCredit({ customerId: r.id, amount: intent.amount, items, dueDate: intent.dueDate, meta: m })));
                        }
                        case 'RECORD_PAYMENT': {
                            const r = resolveCustomer(intent.customerName);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            return out(setPending(service.proposePayment({ customerId: r.id, amount: intent.amount, meta: m })));
                        }
                        case 'CORRECT_ITEM': {
                            const r = resolveCustomer(intent.customerName);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            const c = intent.correction;
                            return out(setPending(service.proposeCorrection({
                                customerId: r.id, itemName: canonicalItem(c.itemName) ?? c.itemName,
                                newTotalAmount: c.newTotalAmount, claimedOldTotal: c.claimedOldTotal ?? null, meta: m,
                            })));
                        }
                        case 'OPEN_DISPUTE': {
                            const r = resolveCustomer(intent.customerName);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            return out(setPending(service.proposeDispute({ customerId: r.id, amount: intent.amount, meta: m })));
                        }
                        default:
                            return out({ reply: 'Samajh nahi aaya, dobara bolo?' });
                    }
                },
            };
        },
    };
}
