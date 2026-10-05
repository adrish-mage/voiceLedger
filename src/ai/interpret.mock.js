// A throwaway rule-based "interpreter" so the whole pipeline runs TODAY with zero AI.
// It only understands the demo phrasings. Replace with interpret.llm.js on Day 2.
// Same signature on purpose: (transcript, context) -> intent object.
import { canonicalItem } from './lexicon.js';
import { emptyIntent } from './schema.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : null);

export async function interpretMock(transcript /* , context */) {
  const t = transcript.trim();
  const base = (over) => emptyIntent({ confidence: 0.9, ...over });

  if (/^(haan|han|ha|yes|ok|okay|theek hai|kar do)[.! ]*$/i.test(t)) return base({ intent: 'CONFIRM' });
  if (/^(nahi|nahin|no|cancel|rehne do)[.! ]*$/i.test(t)) return base({ intent: 'REJECT' });

  // "Nahi, tel 200 nahi, 120 ka tha."
  let m = t.match(/([a-z]+)\s+(\d+)\s+(?:nahi|nahin)[,\s]+(\d+)/i);
  if (m) {
    const item = canonicalItem(m[1]) ?? m[1].toLowerCase();
    return base({ intent: 'CORRECT_ITEM', correction: { itemName: item, claimedOldTotal: +m[2], newTotalAmount: +m[3] } });
  }

  // "Raju bol raha hai usne 300 rupaye de diye the."
  m = t.match(/^(\w+)\s+(?:bol raha|keh raha|kehta|says|claims)[^\d]*(\d+)/i);
  if (m) return base({ intent: 'OPEN_DISPUTE', customerName: cap(m[1]), amount: +m[2] });

  // "Raju ne 500 diye."
  m = t.match(/^(\w+)\s+ne\s+(\d+)[^\d]*(?:diye|de diye|paid|jama)/i);
  if (m) return base({ intent: 'RECORD_PAYMENT', customerName: cap(m[1]), amount: +m[2] });

  // "Raju ko 800 rupaye udhaar likh do, chawal 600 aur tel 200 ka."
  m = t.match(/^(\w+)\s+ko\s+(\d+)[^]*?udhaar([^]*)$/i);
  if (m) {
    const items = [...m[3].matchAll(/([a-z]+)\s+(\d+)/gi)]
      .map((x) => ({ name: canonicalItem(x[1]), totalAmount: +x[2] }))
      .filter((i) => i.name);
    return base({ intent: 'RECORD_CREDIT', customerName: cap(m[1]), amount: +m[2], items: items.length ? items : null });
  }

  // "Raju ka balance kya hai?"
  m = t.match(/^(\w+)\s+ka\s+(?:balance|hisaab|hisab|status)/i);
  if (m) return base({ intent: 'QUERY_BALANCE', customerName: cap(m[1]) });

  if (/overdue/i.test(t)) return base({ intent: 'QUERY_OVERDUE' });
  return emptyIntent({ intent: 'UNKNOWN', ambiguity: 'mock interpreter did not match' });
}
