import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildApp } from '../src/api/server.js';
import { render } from '../src/i18n/messages.js';

const packageInfo = createRequire(import.meta.url)('../package.json');

async function startApi(t, options) {
  const { app, store, service } = buildApp(options);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return {
    store,
    service,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test('API health reports interpreter, currency, and package version', async (t) => {
  const ctx = await startApi(t, { interpreter: 'mock' });
  const response = await fetch(`${ctx.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    interpreter: 'mock',
    currency: ctx.service.currency,
    version: packageInfo.version,
  });
});

test('interpreter errors return a localized 503 without changing the ledger', async (t) => {
  const ctx = await startApi(t, {
    interpret: async () => { throw new Error('model unavailable'); },
  });
  const before = ctx.store.all();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  t.after(() => { console.error = originalError; });

  const response = await fetch(`${ctx.url}/utterance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: 'anything' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'MODEL_UNAVAILABLE',
    reply: render('service_unavailable', {}, 'en'),
  });
  assert.deepEqual(ctx.store.all(), before);
  assert.deepEqual(logged, [['model unavailable']]);
});
