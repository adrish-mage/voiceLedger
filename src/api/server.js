// Tiny HTTP API for the Alexa-style web simulator (build the UI against this).
import express from 'express';
import { createStore } from '../ledger/store.js';
import { createLedgerService } from '../ledger/service.js';
import { createAgent } from '../agent.js';
import { interpretMock } from '../ai/interpret.mock.js';
import { pathToFileURL } from 'node:url';

export function buildApp({ file = process.env.LEDGER_FILE ?? null, interpret = interpretMock } = {}) {
    const store = createStore({ file });
    const service = createLedgerService({ store });
    if (!store.allCustomers().length && process.env.SEED_DEMO !== '0') {
        service.addCustomer({ name: 'Raju', defaultCreditTermDays: 14 });
    }
    const agent = createAgent({ service, interpret });
    const sessions = new Map();
    const session = (req) => {
        const id = req.get('x-session') ?? 'default';
        if (!sessions.has(id)) sessions.set(id, agent.newSession());
        return sessions.get(id);
    };

    const app = express();
    app.use(express.json());

    app.post('/session/open', (req, res) => { sessions.set(req.get('x-session') ?? 'default', agent.newSession()); res.json(session(req).open()); });
    app.post('/utterance', async (req, res) => res.json(await session(req).handle(String(req.body.transcript ?? ''), { speakerId: req.body.speakerId })));
    app.get('/customers', (_req, res) => res.json(store.allCustomers()));
    app.post('/customers', (req, res) => res.json(service.addCustomer(req.body)));
    app.get('/customers/:id/ledger', (req, res) => res.json(service.getLedger(req.params.id)));
    app.get('/customers/:id/audit', (req, res) => res.json(service.getAudit(req.params.id)));
    app.get('/overdue', (_req, res) => res.json(service.overdueAccounts()));
    app.get('/demo-clock', (_req, res) => res.json(service.getClock()));
    app.post('/demo-clock', (req, res) => { service.setDemoClock(req.body.iso ?? null); res.json(service.getClock()); });
    // The agent session also remembers the pending proposal; clear it so a later "yes" can't hit a stale one.
    const clearPending = (id) => { for (const s of sessions.values()) if (s.ctx.pending?.id === id) s.ctx.pending = null; };
    app.post('/proposals/:id/approve', (req, res) => {
        const result = service.approve(req.params.id, { digest: req.body?.digest });
        clearPending(req.params.id);
        res.json(result);
    });
    app.post('/proposals/:id/reject', (req, res) => {
        const result = service.reject(req.params.id);
        clearPending(req.params.id);
        res.json(result);
    });
    return { app, service, store };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = process.env.PORT ?? 3000;
    const interpret = process.env.INTERPRETER === 'llm'
        ? (await import('../ai/interpret.llm.js')).interpretLLM
        : interpretMock;
    buildApp({ interpret }).app.listen(port, () => console.log(`voice-ledger API on http://localhost:${port}`));
}
