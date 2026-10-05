// Append-only event store. In-memory by default, or JSONL file for persistence.
// Events are deep-frozen: nothing can edit a posted event. Swap this file for
// MongoDB later; keep the same four methods and nothing else changes.
import fs from 'node:fs';

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

export function createStore({ file = null } = {}) {
  const events = [];
  const customers = new Map();

  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.kind === 'customer') customers.set(rec.customer.id, rec.customer);
      else if (rec.kind === 'event') events.push(deepFreeze(rec.event));
    }
  }
  const persist = (rec) => {
    if (file) fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  };

  return {
    putCustomer(c) {
      customers.set(c.id, { ...c });
      persist({ kind: 'customer', customer: c });
    },
    getCustomer: (id) => customers.get(id) ?? null,
    allCustomers: () => [...customers.values()],

    // The ONLY way events enter the log. Called only by service.approve().
    append(newEvents) {
      const out = [];
      for (const e of newEvents) {
        const seq = events.length + 1;
        const event = deepFreeze({ ...e, id: `E${String(seq).padStart(2, '0')}`, seq });
        events.push(event);
        out.push(event);
        persist({ kind: 'event', event });
      }
      return out;
    },
    all: () => events.slice(),
    forCustomer: (id) => events.filter((e) => e.customerId === id),
  };
}
