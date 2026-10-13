import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, messages, render } from '../src/i18n/messages.js';
import { createAgent } from '../src/agent.js';
import { emptyIntent } from '../src/ai/schema.js';
import { createLedgerService } from '../src/ledger/service.js';
import { createStore } from '../src/ledger/store.js';

test('every message template has the same placeholders in every language', () => {
  const languages = Object.keys(messages);
  const placeholders = (template) => [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
    .map((match) => match[1]).sort();

  for (const key of Object.keys(messages.en)) {
    const expected = placeholders(messages.en[key]);
    for (const language of languages) {
      assert.deepEqual(placeholders(messages[language][key]), expected, `${language}.${key}`);
    }
  }
});

test('money formatting respects currency and omits fractional digits', () => {
  assert.equal(formatMoney(1234.7, 'INR', 'en'), '₹1,235');
  assert.equal(formatMoney(1234.7, 'USD', 'en'), '$1,235');
  assert.equal(formatMoney(1234.7, 'KES', 'sw'), 'Ksh 1,235');
});

test('render falls back to English for unsupported language and key', () => {
  assert.equal(render('whichCustomer', {}, 'de'), messages.en.whichCustomer);
  assert.equal(render('unknownMessage', {}, 'fr'), 'unknownMessage');
});

test('agent selects Hindi script, remembers it for confirmation, and falls back for unknown language', async () => {
  const service = createLedgerService({ store: createStore(), currency: 'USD' });
  service.addCustomer({ name: 'Raju' });
  const interpret = async (transcript) => {
    if (transcript === 'देवनागरी') return emptyIntent({ intent: 'RECORD_CREDIT', customerName: 'Raju', amount: 500, confidence: 0.9, lang: 'hi' });
    if (transcript === 'latin hindi') return emptyIntent({ intent: 'RECORD_CREDIT', customerName: 'Raju', amount: 200, confidence: 0.9, lang: 'hi' });
    if (transcript === 'unknown language') return emptyIntent({ intent: 'QUERY_BALANCE', customerName: 'Raju', confidence: 0.9, lang: 'de' });
    return emptyIntent({ intent: 'CONFIRM', confidence: 0.9 });
  };
  const session = createAgent({ service, interpret }).newSession();

  const hindiReadBack = await session.handle('देवनागरी');
  assert.match(hindiReadBack.reply, /उधार/);
  const hindiConfirmation = await session.handle('हाँ');
  assert.match(hindiConfirmation.reply, /दर्ज हो गया/);
  assert.ok(hindiConfirmation.reply.includes(formatMoney(500, 'USD', 'hi')));

  const hinglishReadBack = await session.handle('latin hindi');
  assert.match(hinglishReadBack.reply, /udhaar/);
  const englishFallback = await session.handle('unknown language');
  assert.match(englishFallback.reply, /outstanding balance/);
});