import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { createStore } from '../ledger/store.js';
import { createLedgerService } from '../ledger/service.js';

const proposalInstruction = 'Read the readBack text to the user and wait for an explicit yes before calling approve_proposal. Never approve on your own.';

const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

function resolveCustomer(service, customerName) {
  const matches = service.findCustomers(customerName);
  if (matches.length === 1) return { customer: matches[0] };
  const candidates = matches.map((customer) => customer.name);
  if (matches.length === 0) {
    return { error: `No customer matched "${customerName}". Candidates: none. Please provide a customer name.` };
  }
  return { error: `"${customerName}" matched several customers: ${candidates.join(', ')}. Which one do you mean?` };
}

function registerTools(server, service) {
  server.registerTool('list_customers', {
    description: 'List all customers.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => textResult(service.findCustomers('').map(({ id, name }) => ({ id, name }))));

  server.registerTool('get_balance', {
    description: 'Read a customer ledger and current balance.',
    inputSchema: { customerName: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ customerName }) => {
    const resolved = resolveCustomer(service, customerName);
    if (resolved.error) return errorResult(resolved.error);
    const result = service.getLedger(resolved.customer.id);
    return result.ok ? textResult(result) : errorResult(result.message);
  });

  server.registerTool('list_overdue', {
    description: 'List customers with overdue accounts.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => textResult(service.overdueAccounts()));

  server.registerTool('get_audit', {
    description: 'Read the event audit history for a customer.',
    inputSchema: { customerName: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ customerName }) => {
    const resolved = resolveCustomer(service, customerName);
    if (resolved.error) return errorResult(resolved.error);
    return textResult(service.getAudit(resolved.customer.id));
  });

  const registerProposal = (name, description, inputSchema, propose) => {
    server.registerTool(name, {
      description: `${description} ${proposalInstruction}`,
      inputSchema,
    }, async (input) => {
      const resolved = resolveCustomer(service, input.customerName);
      if (resolved.error) return errorResult(resolved.error);
      const result = propose({ ...input, customerId: resolved.customer.id });
      if (!result.ok) return errorResult(result.message);
      const { id: proposalId, digest, readBack, display, warnings } = result.proposal;
      const structuredContent = { proposalId, digest, readBack, display, warnings };
      return { ...textResult(structuredContent), structuredContent };
    });
  };

  registerProposal('propose_credit', 'Propose a credit entry without writing to the ledger.', {
    customerName: z.string().min(1),
    amount: z.number().int().positive(),
    items: z.array(z.object({
      name: z.string().min(1),
      quantity: z.number().positive().optional(),
      totalAmount: z.number().int().positive(),
    })).optional(),
    dueDate: z.string().optional(),
  }, ({ customerId, amount, items, dueDate }) => service.proposeCredit({ customerId, amount, items, dueDate }));

  registerProposal('propose_payment', 'Propose a payment without writing to the ledger.', {
    customerName: z.string().min(1),
    amount: z.number().int().positive(),
  }, ({ customerId, amount }) => service.proposePayment({ customerId, amount }));

  registerProposal('propose_correction', 'Propose an item correction without writing to the ledger.', {
    customerName: z.string().min(1),
    itemName: z.string().min(1),
    newTotalAmount: z.number().int().nonnegative(),
    claimedOldTotal: z.number().int().nonnegative().optional(),
  }, ({ customerId, itemName, newTotalAmount, claimedOldTotal }) => service.proposeCorrection({
    customerId, itemName, newTotalAmount, claimedOldTotal,
  }));

  registerProposal('propose_dispute', 'Propose opening a payment dispute without writing to the ledger.', {
    customerName: z.string().min(1),
    amount: z.number().int().positive(),
  }, ({ customerId, amount }) => service.proposeDispute({ customerId, amount }));

  server.registerTool('approve_proposal', {
    description: 'Approve a pending proposal using its exact digest.',
    inputSchema: { proposalId: z.string().min(1), digest: z.string().min(1) },
  }, async ({ proposalId, digest }) => {
    const result = service.approve(proposalId, { digest });
    return result.ok ? textResult(result) : errorResult(result.message);
  });

  server.registerTool('reject_proposal', {
    description: 'Reject a pending proposal.',
    inputSchema: { proposalId: z.string().min(1) },
  }, async ({ proposalId }) => {
    const result = service.reject(proposalId);
    return result.ok ? textResult(result) : errorResult(result.message);
  });
}

export function buildMcpApp({ service, authToken = process.env.MCP_AUTH_TOKEN || null } = {}) {
  if (!service) throw new TypeError('buildMcpApp requires a ledger service.');
  const app = express();
  const allowedOrigins = new Set((process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',').map((origin) => origin.trim()).filter(Boolean));

  app.use('/mcp', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    if (req.method === 'POST' && authToken && req.get('authorization') !== `Bearer ${authToken}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  });
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'voice-ledger', version: '1.0.0' });
    registerTools(server, service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST /mcp' }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Stateless MCP transport does not use DELETE' }));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = createStore({ file: process.env.LEDGER_FILE ?? null });
  const service = createLedgerService({ store });
  if (!store.allCustomers().length && process.env.SEED_DEMO !== '0') {
    service.addCustomer({ name: 'Raju', defaultCreditTermDays: 14 });
  }
  const port = process.env.MCP_PORT ?? 3001;
  buildMcpApp({ service, authToken: process.env.MCP_AUTH_TOKEN || null })
    .listen(port, () => console.log(`voice-ledger MCP on http://localhost:${port}/mcp`));
}