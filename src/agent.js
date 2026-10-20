// Orchestrator: transcript -> interpret -> validate -> propose -> (user says haan) -> approve.
// The agent holds conversation state (who are we talking about? what's pending?).
// It can only call service.propose*/approve/reject. It has no way to write events.
import { validateIntent } from './ai/schema.js';
import { canonicalItem } from './ai/lexicon.js';
import { render, formatMoney } from './i18n/messages.js';

export function createAgent({ service, interpret }) {
    return {
        newSession() {
            const ctx = { customerId: null, pending: null, lang: 'en' };
            const nameOf = (cid) => service.getLedger(cid).customer.name; // gets customer id
            const message = (key, params = {}, lang = ctx.lang) => render(key, params, lang);
            const money = (amount, lang = ctx.lang) => formatMoney(amount, service.currency ?? process.env.CURRENCY ?? 'INR', lang);

            const resolveCustomer = (name, spoken) => {
                if (name == null && spoken === true) return { ok: false, reply: message('whichCustomer') };
                if (!name) return ctx.customerId ? { ok: true, id: ctx.customerId } : { ok: false, reply: message('whichCustomer') };
                const found = service.findCustomers(name);
                if (found.length === 0) return { ok: false, reply: message('customerNotFound', { name }) };
                if (found.length > 1) return { ok: false, reply: message('ambiguousCustomer', { query: name, matches: found.map((c) => c.name).join(message('itemJoiner')) }) };
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
                    display: res.proposal.display, // what to display
                    lang: ctx.lang,
                };         
                return { reply: res.proposal.readBack, proposal: res.proposal };
            };

            const balanceLine = (cid) => {
                const { customer, ledger: l } = service.getLedger(cid);
                if (l.status === 'CLEAR') return message('balanceClear', { customer: customer.name });
                const disputed = l.disputedAmount
                    ? message('balanceDisputed', { disputed: money(l.disputedAmount) }) : '';
                const overdue = l.isOverdue ? message('overdueSuffix') : '';
                return message('balanceOutstanding', { customer: customer.name, balance: money(l.balance), disputed, overdue });
            };

            return {
                ctx,
                // Proactive: call when a session starts (Alexa-style "good morning" briefing)
                open() {
                    const s = service.sessionOpen();
                    const lines = s.overdue.filter((x) => x.newlyOverdue).map((x) =>
                        message('overdueBriefing', { customer: x.customer.name, amount: money(x.ledger.overdueEligibleAmount) }));
                    return { reply: lines.join(' ') || null, overdue: s.overdue, clock: s.clock };
                },

                async handle(transcript, meta = {}) {
                    const raw = await interpret(transcript, { // calls the AI
                        customers: service.listCustomerNames(),
                        lastCustomer: ctx.customerId ? nameOf(ctx.customerId) : null,
                    });
                    const checked = validateIntent(raw);
                    if (!checked.ok) return { reply: message('didntUnderstand'), intent: null, errors: checked.errors };
                    const intent = checked.value;
                    const knownLanguages = ['en', 'hi', 'es', 'pt', 'fr', 'id', 'sw'];
                    if (intent.lang != null) {
                        const spokenLanguage = intent.lang.toLowerCase();
                        if (spokenLanguage === 'hi') ctx.lang = /[\u0900-\u097F]/.test(transcript) ? 'hi' : 'hinglish';
                        else ctx.lang = knownLanguages.includes(spokenLanguage) ? spokenLanguage : 'en';
                    }
                    const lang = ctx.lang;
                    const m = {
                        channel: meta.channel ?? 'TEXT', transcript, language: intent.lang ?? intent.language, lang,
                        speakerId: meta.speakerId ?? null, confidence: intent.confidence, extractedEntities: intent,
                    };
                    const out = (o) => ({ intent, ...o });

                    if (intent.intent === 'UNKNOWN') return out({ reply: message('didntUnderstand') });
                    const writes = ['RECORD_CREDIT', 'RECORD_PAYMENT', 'CORRECT_ITEM', 'OPEN_DISPUTE'];
                    if (writes.includes(intent.intent) && intent.confidence < 0.6) {
                        return out({ reply: message('lowConfidence') }); // never write on low confidence
                    }

                    switch (intent.intent) {
                        case 'CONFIRM': {
                            if (!ctx.pending) return out({ reply: message('nothingToConfirm') });
                            // The UI must have SHOWN the proposal before the user said "haan".
                            // The digest ties this yes to exactly that proposal.
                            const p = ctx.pending;
                            const res = service.approve(p.id, { digest: p.digest, lang: p.lang });
                            if (!res.ok) { ctx.pending = null; return out({ reply: res.message, error: res }); }
                            ctx.pending = null;
                            const l = res.ledger;
                            const name = nameOf(p.customerId);
                            const lines = {
                                CREDIT: message('recordedCredit', { customer: name, balance: money(l.balance) }, p.lang),
                                PAYMENT: message('recordedPayment', { customer: name, balance: money(l.balance) }, p.lang),
                                CORRECTION: message('recordedCorrection', { customer: name, balance: money(l.balance) }, p.lang),
                                DISPUTE_OPEN: message('recordedDispute', { customer: name, balance: money(l.balance) }, p.lang),
                                DISPUTE_RESOLVE: message('recordedDisputeResolution', { customer: name, balance: money(l.balance) }, p.lang),
                            };
                            return out({ reply: lines[p.kind], committed: res.events, ledger: l });
                        }
                        case 'REJECT': {
                            if (!ctx.pending) return out({ reply: message('okay') });
                            service.reject(ctx.pending.id);
                            ctx.pending = null;
                            return out({ reply: message('cancelled') });
                        }
                        case 'QUERY_BALANCE': {
                            const r = resolveCustomer(intent.customerName, intent.customerSpoken);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            return out({ reply: balanceLine(r.id), ledger: service.getLedger(r.id).ledger });
                        }
                        case 'QUERY_OVERDUE': {
                            const list = service.overdueAccounts();
                            if (!list.length) return out({ reply: message('noOverdue') });
                            const items = list.map((x) => message('overdueListItem', { customer: x.customer.name, amount: money(x.ledger.overdueEligibleAmount) }));
                            return out({ reply: items.join(message('overdueJoiner')) + '.' });
                        }
                        case 'RECORD_CREDIT': {
                            const r = resolveCustomer(intent.customerName, intent.customerSpoken);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            const items = (intent.items ?? []).map((i) => ({ ...i, name: canonicalItem(i.name) ?? i.name }));
                            return out(setPending(service.proposeCredit({ customerId: r.id, amount: intent.amount, items, dueDate: intent.dueDate, meta: m })));
                        }
                        case 'RECORD_PAYMENT': {
                            const r = resolveCustomer(intent.customerName, intent.customerSpoken);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            return out(setPending(service.proposePayment({ customerId: r.id, amount: intent.amount, meta: m })));
                        }
                        case 'CORRECT_ITEM': {
                            const r = resolveCustomer(intent.customerName, intent.customerSpoken);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            const c = intent.correction;
                            return out(setPending(service.proposeCorrection({
                                customerId: r.id, itemName: canonicalItem(c.itemName) ?? c.itemName,
                                newTotalAmount: c.newTotalAmount, claimedOldTotal: c.claimedOldTotal ?? null, meta: m,
                            })));
                        }
                        case 'OPEN_DISPUTE': {
                            const r = resolveCustomer(intent.customerName, intent.customerSpoken);
                            if (!r.ok) return out({ reply: r.reply });
                            ctx.customerId = r.id;
                            return out(setPending(service.proposeDispute({ customerId: r.id, amount: intent.amount, meta: m })));
                        }
                        default:
                            return out({ reply: message('didntUnderstand') });
                    }
                },
            };
        },
    };
}
