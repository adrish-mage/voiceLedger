import { useCallback, useEffect, useRef, useState } from 'react';

const SESSION_ID = globalThis.crypto?.randomUUID?.() ?? (() => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
})();

const CURRENCIES = ['INR', 'USD', 'EUR', 'KES', 'IDR', 'BRL'];
const LANGUAGES = ['en-US', 'en-IN', 'hi-IN', 'es-ES', 'pt-BR', 'fr-FR', 'id-ID', 'sw-KE'];
const STATUS_LABELS = {
  CLEAR: 'Clear',
  OUTSTANDING: 'Outstanding',
  OVERDUE: 'Overdue',
  DISPUTED: 'Disputed',
};
const API_BASE = '/api';

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-session': SESSION_ID,
      ...options.headers,
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Request failed (${response.status})`);
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.message ?? `Request failed (${response.status})`);
  }
  return body;
}

const postJson = (path, payload) => api(path, {
  method: 'POST',
  body: JSON.stringify(payload),
});

function formatMoney(amount, currency) {
  if (!Number.isFinite(Number(amount))) return String(amount ?? '');
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number(amount));
}

function formatDate(value) {
  if (!value) return 'No due date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function formatTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function ProposalCard({ proposal, currency, action, onDecide }) {
  const display = proposal.display ?? {};
  const monetaryFields = [
    ['amount', 'Amount'],
    ['total', 'Total'],
    ['claimedAmount', 'Claimed amount'],
    ['balanceUnchanged', 'Balance unchanged'],
    ['delta', 'Change'],
    ['creditTotalBefore', 'Credit total before'],
    ['creditTotalAfter', 'Credit total after'],
    ['balanceBefore', 'Balance before'],
    ['balanceAfter', 'Balance after'],
  ];
  const visibleMoney = monetaryFields.filter(([key]) => display[key] !== undefined);

  return (
    <section className="proposal-card" aria-label="Proposal confirmation">
      <div className="proposal-heading">
        <div>
          <span className="eyebrow">Pending approval</span>
          <h3>{display.customer ?? proposal.kind}</h3>
        </div>
        <span className="proposal-id">{proposal.id}</span>
      </div>
      <p className="read-back">“{proposal.readBack}”</p>
      {visibleMoney.length > 0 && (
        <dl className="proposal-facts">
          {visibleMoney.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{formatMoney(display[key], currency)}</dd>
            </div>
          ))}
        </dl>
      )}
      {Array.isArray(display.items) && display.items.length > 0 && (
        <div className="proposal-items">
          <span className="field-label">Items</span>
          <ul>
            {display.items.map((item, index) => (
              <li key={`${item.name}-${index}`}>
                <span>{item.name}{item.quantity != null ? ` · ${item.quantity}` : ''}</span>
                <strong>{formatMoney(item.totalAmount ?? item.amount ?? 0, currency)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
      {display.dueDate && <p className="proposal-due">Due {formatDate(display.dueDate)}</p>}
      {Array.isArray(display.before) && Array.isArray(display.after) && (
        <div className="correction-diff">
          <span>Correction preview</span>
          <p>{display.before.map((item) => `${item.name}: ${formatMoney(item.totalAmount, currency)}`).join(', ')}</p>
          <p>{display.after.map((item) => `${item.name}: ${formatMoney(item.totalAmount, currency)}`).join(', ')}</p>
        </div>
      )}
      {proposal.warnings?.length > 0 && (
        <ul className="warning-list">
          {proposal.warnings.map((warning) => <li key={warning}>{warning.replaceAll('_', ' ')}</li>)}
        </ul>
      )}
      {action?.message && <p className="inline-error" role="alert">{action.message}</p>}
      <div className="proposal-actions">
        <button
          className="button button-primary"
          type="button"
          disabled={Boolean(action?.used)}
          onClick={() => onDecide(proposal, 'approve')}
        >
          {action?.status === 'approved' ? 'Confirmed' : 'Confirm'}
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={Boolean(action?.used)}
          onClick={() => onDecide(proposal, 'reject')}
        >
          {action?.status === 'rejected' ? 'Rejected' : 'Reject'}
        </button>
      </div>
    </section>
  );
}

export default function App() {
  const [currency, setCurrency] = useState('INR');
  const [language, setLanguage] = useState('en-IN');
  const [messages, setMessages] = useState([]);
  const [transcript, setTranscript] = useState('');
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState(null);
  const [rows, setRows] = useState([]);
  const [clock, setClock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);
  const [error, setError] = useState('');
  const [panelError, setPanelError] = useState('');
  const [expandedCustomer, setExpandedCustomer] = useState(null);
  const [audits, setAudits] = useState({});
  const [auditLoading, setAuditLoading] = useState({});
  const [customerName, setCustomerName] = useState('');
  const [creditTerm, setCreditTerm] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [proposalActions, setProposalActions] = useState({});
  const [clockBusy, setClockBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const expandedCustomerRef = useRef(null);
  const scrollRef = useRef(null);
  const speechSupported = typeof window !== 'undefined'
    && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const refreshPanel = useCallback(async () => {
    setPanelLoading(true);
    setPanelError('');
    try {
      const customers = await api('/customers');
      const nextRows = await Promise.all(customers.map(async (customer) => {
        const result = await api(`/customers/${encodeURIComponent(customer.id)}/ledger`);
        return { customer, ledger: result.ledger };
      }));
      setRows(nextRows);
      const auditCustomerId = expandedCustomerRef.current;
      if (auditCustomerId) {
        const audit = await api(`/customers/${encodeURIComponent(auditCustomerId)}/audit`);
        setAudits((current) => ({ ...current, [auditCustomerId]: audit }));
      }
    } catch (requestError) {
      setPanelError(requestError.message);
    } finally {
      setPanelLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function initialize() {
      setLoading(true);
      try {
        const [opening, currentClock] = await Promise.all([
          postJson('/session/open', {}),
          api('/demo-clock'),
        ]);
        if (!active) return;
        setBanner(opening.reply);
        setClock(currentClock);
        await refreshPanel();
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    initialize();
    return () => { active = false; };
  }, [refreshPanel]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  const sendUtterance = useCallback(async (value) => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setTranscript('');
    setError('');
    try {
      const response = await postJson('/utterance', { transcript: text });
      setMessages((current) => [...current, {
        id: `${Date.now()}-${Math.random()}`,
        transcript: text,
        response,
      }]);
      await refreshPanel();
    } catch (requestError) {
      setMessages((current) => [...current, {
        id: `${Date.now()}-${Math.random()}`,
        transcript: text,
        response: { reply: requestError.message, error: { message: requestError.message } },
      }]);
      setError(requestError.message);
    } finally {
      setSending(false);
    }
  }, [refreshPanel, sending]);

  async function decideProposal(proposal, decision) {
    setProposalActions((current) => ({
      ...current,
      [proposal.id]: { used: true, status: decision === 'approve' ? 'approving' : 'rejecting' },
    }));
    try {
      const result = decision === 'approve'
        ? await postJson(`/proposals/${encodeURIComponent(proposal.id)}/approve`, { digest: proposal.digest })
        : await postJson(`/proposals/${encodeURIComponent(proposal.id)}/reject`, {});
      setProposalActions((current) => ({
        ...current,
        [proposal.id]: { used: true, status: decision === 'approve' ? 'approved' : 'rejected' },
      }));
      if (!result.ok && result.message) {
        setProposalActions((current) => ({
          ...current,
          [proposal.id]: { used: true, status: decision, message: result.message },
        }));
      }
      await refreshPanel();
    } catch (requestError) {
      setProposalActions((current) => ({
        ...current,
        [proposal.id]: { used: true, status: decision, message: requestError.message },
      }));
      setError(requestError.message);
      await refreshPanel();
    }
  }

  async function toggleAudit(customerId) {
    if (expandedCustomer === customerId) {
      expandedCustomerRef.current = null;
      setExpandedCustomer(null);
      return;
    }
    expandedCustomerRef.current = customerId;
    setExpandedCustomer(customerId);
    setAuditLoading((current) => ({ ...current, [customerId]: true }));
    try {
      const audit = await api(`/customers/${encodeURIComponent(customerId)}/audit`);
      setAudits((current) => ({ ...current, [customerId]: audit }));
    } catch (requestError) {
      setPanelError(requestError.message);
    } finally {
      setAuditLoading((current) => ({ ...current, [customerId]: false }));
    }
  }

  async function addCustomer(event) {
    event.preventDefault();
    if (!customerName.trim()) return;
    setAddingCustomer(true);
    setPanelError('');
    try {
      await postJson('/customers', {
        name: customerName.trim(),
        defaultCreditTermDays: creditTerm === '' ? null : Number(creditTerm),
      });
      setCustomerName('');
      setCreditTerm('');
      await refreshPanel();
    } catch (requestError) {
      setPanelError(requestError.message);
    } finally {
      setAddingCustomer(false);
    }
  }

  async function changeClock(days) {
    if (!clock?.now) return;
    setClockBusy(true);
    setError('');
    try {
      const iso = new Date(new Date(clock.now).getTime() + days * 86_400_000).toISOString();
      setClock(await postJson('/demo-clock', { iso }));
      await refreshPanel();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setClockBusy(false);
    }
  }

  async function resetClock() {
    setClockBusy(true);
    setError('');
    try {
      setClock(await postJson('/demo-clock', { iso: null }));
      await refreshPanel();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setClockBusy(false);
    }
  }

  function startListening() {
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.lang = language;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognitionRef.current = recognition;
    recognition.onresult = (event) => {
      const finalText = [...event.results]
        .filter((result) => result.isFinal)
        .map((result) => result[0].transcript)
        .join(' ')
        .trim();
      if (finalText) {
        setTranscript(finalText);
        recognition.stop();
        setListening(false);
        sendUtterance(finalText);
      }
    };
    recognition.onerror = (event) => {
      setError(`Microphone: ${event.error}`);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognition.start();
    setListening(true);
  }

  function submitText(event) {
    event.preventDefault();
    sendUtterance(transcript);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Voice Ledger home">
          <span className="brand-mark">VL</span>
          <span>Voice Ledger <small>SIMULATOR</small></span>
        </a>
        <div className="topbar-tools">
          <label className="select-control">
            <span>Display currency</span>
            <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
              {CURRENCIES.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <div className="session-mark"><span /> Session active</div>
        </div>
      </header>

      <div className="workspace" id="top">
        <section className="conversation-panel" aria-label="Voice assistant conversation">
          <div className="conversation-head">
            <div>
              <span className="eyebrow">Assistant console</span>
              <h1>Ledger conversation</h1>
            </div>
            <span className="live-indicator"><span /> API connected</span>
          </div>

          {banner && <div className="briefing-banner"><span className="banner-icon">!</span>{banner}</div>}
          {error && <div className="error-banner" role="alert">{error}</div>}

          <div className="messages" ref={scrollRef} aria-live="polite">
            {loading && <div className="empty-state"><span className="loader" />Connecting to the ledger…</div>}
            {!loading && messages.length === 0 && (
              <div className="empty-state">
                <div className="empty-mark">01</div>
                <p>Start with a customer request</p>
                <span>Ask for a balance, record a credit, or note a payment.</span>
              </div>
            )}
            {messages.map((message) => (
              <article className="conversation-turn" key={message.id}>
                <div className="bubble bubble-user">
                  <span className="bubble-label">YOU</span>
                  <p>{message.transcript}</p>
                </div>
                <div className="assistant-line">
                  <span className="assistant-avatar">VL</span>
                  <div className="assistant-content">
                    <div className="assistant-meta">
                      <span>Assistant</span>
                      {message.response.intent?.intent && <span className="intent-chip">{message.response.intent.intent}</span>}
                    </div>
                    <div className="bubble bubble-assistant">
                      <p>{message.response.reply ?? 'No reply received.'}</p>
                    </div>
                    {message.response.error?.message && (
                      <p className="message-error">{message.response.error.message}</p>
                    )}
                    {message.response.proposal && (
                      <ProposalCard
                        proposal={message.response.proposal}
                        currency={currency}
                        action={proposalActions[message.response.proposal.id]}
                        onDecide={decideProposal}
                      />
                    )}
                    <details className="raw-json">
                      <summary>Raw response</summary>
                      <pre>{JSON.stringify(message.response, null, 2)}</pre>
                    </details>
                  </div>
                </div>
              </article>
            ))}
            {sending && <div className="typing-indicator"><span /><span /><span />Interpreting request</div>}
          </div>

          <form className="composer" onSubmit={submitText}>
            <div className="composer-input-wrap">
              <input
                aria-label="Message the voice assistant"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                placeholder="Try: Raju ko 200 udhaar likho…"
                disabled={loading || sending}
              />
              {speechSupported && (
                <button
                  type="button"
                  className={`mic-button${listening ? ' is-listening' : ''}`}
                  aria-label={listening ? 'Stop microphone' : 'Start microphone'}
                  title={listening ? 'Stop microphone' : 'Start microphone'}
                  onClick={() => {
                    if (listening) recognitionRef.current?.stop();
                    else startListening();
                    setListening(!listening);
                  }}
                  disabled={loading || sending}
                >
                  <span aria-hidden="true">{listening ? 'Stop' : 'Mic'}</span>
                </button>
              )}
            </div>
            <label className="language-control">
              <span>Speech language</span>
              <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                {LANGUAGES.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <button className="send-button" type="submit" disabled={loading || sending || !transcript.trim()}>
              <span>{sending ? 'Sending…' : 'Send'}</span><span aria-hidden="true">↗</span>
            </button>
          </form>
          <div className="composer-foot"><span>Enter to send</span><span>Speech recognition {speechSupported ? 'available' : 'not supported'}</span></div>
        </section>

        <aside className="side-panel" aria-label="Ledger controls and customers">
          <section className="clock-section">
            <div className="section-heading">
              <div><span className="eyebrow">Time controls</span><h2>Demo clock</h2></div>
              <span className={`clock-mode${clock?.isDemoClock ? ' is-demo' : ''}`}>{clock?.isDemoClock ? 'SIMULATED' : 'LIVE'}</span>
            </div>
            <div className="clock-display">{clock ? formatTimestamp(clock.now) : 'Loading clock…'}</div>
            <div className="clock-actions">
              <button className="button button-secondary" onClick={() => changeClock(1)} disabled={clockBusy || !clock}>+1 day</button>
              <button className="button button-secondary" onClick={() => changeClock(15)} disabled={clockBusy || !clock}>+15 days</button>
              <button className="button button-quiet" onClick={resetClock} disabled={clockBusy}>Reset</button>
            </div>
          </section>

          <section className="customers-section">
            <div className="section-heading customer-heading">
              <div><span className="eyebrow">Account book</span><h2>Customers <span className="count">{rows.length}</span></h2></div>
              <button className="refresh-button" onClick={refreshPanel} disabled={panelLoading} title="Refresh customers" aria-label="Refresh customers">↻</button>
            </div>
            {panelError && <div className="panel-error" role="alert">{panelError}</div>}
            {panelLoading && <div className="panel-loading"><span className="loader" />Refreshing balances…</div>}
            {!panelLoading && rows.length === 0 && <p className="no-customers">No customer accounts yet.</p>}
            <div className="customer-list">
              {rows.map(({ customer, ledger }) => (
                <article className="customer-row" key={customer.id}>
                  <div className="customer-main">
                    <div className="customer-title">
                      <div><h3>{customer.name}</h3><span className="customer-id">{customer.id}</span></div>
                      <span className={`status-badge status-${ledger.status.toLowerCase()}`}>
                        <span />{STATUS_LABELS[ledger.status] ?? ledger.status}
                      </span>
                    </div>
                    <div className="customer-balance">
                      <strong>{formatMoney(ledger.balance, currency)}</strong>
                      <span>balance</span>
                    </div>
                    <div className="ledger-meta">
                      {ledger.disputedAmount > 0 && <span className="disputed-value">Disputed {formatMoney(ledger.disputedAmount, currency)}</span>}
                      {ledger.dueDate && <span>Due {formatDate(ledger.dueDate)}</span>}
                      <span>{ledger.transactionCount} {ledger.transactionCount === 1 ? 'entry' : 'entries'}</span>
                    </div>
                    <button
                      type="button"
                      className="audit-toggle"
                      aria-expanded={expandedCustomer === customer.id}
                      onClick={() => toggleAudit(customer.id)}
                    >
                      {expandedCustomer === customer.id ? 'Hide audit trail' : 'View audit trail'}
                      <span aria-hidden="true">{expandedCustomer === customer.id ? '−' : '+'}</span>
                    </button>
                    {expandedCustomer === customer.id && (
                      <div className="audit-trail">
                        {auditLoading[customer.id] && <p className="audit-empty">Loading audit…</p>}
                        {!auditLoading[customer.id] && (!audits[customer.id] || audits[customer.id].length === 0) && (
                          <p className="audit-empty">No audit events yet.</p>
                        )}
                        {!auditLoading[customer.id] && audits[customer.id]?.map((event) => (
                          <div className="audit-event" key={event.eventId}>
                            <span className="audit-dot" />
                            <div>
                              <strong>{event.type.replaceAll('_', ' ')}</strong>
                              <p>{formatTimestamp(event.timestamp)}</p>
                              <span>{event.approvalStatus}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="add-customer-section">
            <div className="section-heading"><div><span className="eyebrow">New account</span><h2>Add customer</h2></div></div>
            <form className="customer-form" onSubmit={addCustomer}>
              <label>
                <span>Customer name</span>
                <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="e.g. Meena" required />
              </label>
              <label>
                <span>Credit term <small>days, optional</small></span>
                <input type="number" min="0" step="1" value={creditTerm} onChange={(event) => setCreditTerm(event.target.value)} placeholder="No default" />
              </label>
              <button className="button button-primary add-button" type="submit" disabled={addingCustomer || !customerName.trim()}>
                {addingCustomer ? 'Adding…' : 'Add to ledger'}
              </button>
            </form>
          </section>
        </aside>
      </div>
      <footer className="page-foot"><span>Voice Ledger</span><span>Approval-gated entries · Local simulator</span></footer>
    </main>
  );
}