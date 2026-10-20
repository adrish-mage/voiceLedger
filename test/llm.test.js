import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../src/ai/interpret.llm.js';

const messages = [
  { role: 'system', content: 'system instruction' },
  { role: 'user', content: 'hello' },
];

test('callModel retries a throttled Bedrock request once after the delay', async () => {
  let calls = 0;
  const startedAt = Date.now();
  const stub = {
    async send() {
      calls += 1;
      if (calls === 1) {
        const error = new Error('throttled');
        error.name = 'ThrottlingException';
        throw error;
      }
      return { output: { message: { content: [{ text: 'response' }] } } };
    },
  };

  assert.equal(await callModel(messages, stub), 'response');
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt >= 590);
});

test('callModel rethrows non-retryable Bedrock errors unchanged', async () => {
  const original = new Error('bad request');
  original.name = 'ValidationException';
  let calls = 0;
  const stub = {
    async send() {
      calls += 1;
      throw original;
    },
  };

  await assert.rejects(callModel(messages, stub), (error) => error === original);
  assert.equal(calls, 1);
});
