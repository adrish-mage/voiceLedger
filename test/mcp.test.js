import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStore } from '../src/ledger/store.js';
import { createLedgerService } from '../src/ledger/service.js';
import { buildMcpApp } from '../src/mcp/ledger.js';

async function setup({ authToken = null, customers = ['Raju'] } = {}) {
  const store = createStore();
  const service = createLedgerService({ store });
  for (const name of customers) service.addCustomer({ name });
  const server = buildMcpApp({ service, authToken }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'voice-ledger-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined,
  });
  await client.connect(transport);
  return {
    client,
    service,
    store,
    url,
    async close() {
      await client.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('propose then approve with the right digest changes the balance', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const proposed = await call(ctx.client, 'propose_credit', { customerName: 'Raju', amount: 800 });
  assert.equal(ctx.store.all().length, 0);
  const { proposalId, digest, readBack } = proposed.structuredContent;
  assert.ok(readBack);
  const approved = await call(ctx.client, 'approve_proposal', { proposalId, digest });
  assert.equal(approved.isError, undefined);
  assert.equal(ctx.service.getLedger('C1').ledger.balance, 800);
});

test('wrong digest fails and writes nothing', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const proposed = await call(ctx.client, 'propose_credit', { customerName: 'Raju', amount: 800 });
  const result = await call(ctx.client, 'approve_proposal', {
    proposalId: proposed.structuredContent.proposalId,
    digest: 'wrong-digest',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Approval does not match this proposal/);
  assert.equal(ctx.store.all().length, 0);
  assert.equal(ctx.service.getLedger('C1').ledger.balance, 0);
});

test('a proposal alone writes nothing', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  await call(ctx.client, 'propose_payment', { customerName: 'Raju', amount: 100 });
  assert.equal(ctx.store.all().length, 0);
});

test('ambiguous customer name returns isError with candidates', async (t) => {
  const ctx = await setup({ customers: ['Raju Sharma', 'Raju Verma'] });
  t.after(() => ctx.close());
  const result = await call(ctx.client, 'get_balance', { customerName: 'Raju' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Raju Sharma, Raju Verma/);
});

test('requires bearer token when configured', async (t) => {
  const ctx = await setup({ authToken: 'test-secret' });
  t.after(() => ctx.close());
  const response = await fetch(ctx.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } } }),
  });
  assert.equal(response.status, 401);
});

test('raw initialize negotiates protocol version 2025-11-25', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const response = await fetch(ctx.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } } }),
  });
  assert.equal(response.status, 200);
  const eventStream = await response.text();
  const data = eventStream.match(/^data: (.+)$/m)?.[1];
  assert.ok(data, eventStream);
  const result = JSON.parse(data);
  assert.equal(result.result.protocolVersion, '2025-11-25');
});

test('propose_credit renders a Spanish read-back when language is es', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const proposed = await call(ctx.client, 'propose_credit', {
    customerName: 'Raju',
    amount: 100,
    language: 'es',
  });
  const { readBack } = proposed.structuredContent;
  assert.match(readBack, /crédito/);
  assert.match(readBack, /Raju/);
  assert.match(readBack, /100/);
});