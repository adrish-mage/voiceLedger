// Runs every automated check and prints ONE verdict. Default mode needs no AWS key.
//   node scripts/verify-all.mjs                         (rules-only mock interpreter, no network)
//   node --env-file=.env scripts/verify-all.mjs --llm   (adds one live Bedrock check)
// It starts its own API and MCP servers on free ports (in-memory ledger, nothing persisted)
// and stops them afterwards. Run it with no other servers using ports 3000/3001.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const WITH_LLM = process.argv.includes('--llm');

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? ' - ' + detail : ''}`);
};
async function check(name, fn) {
  try {
    const r = await fn();
    if (r?.skip) record(name, 'SKIP', r.skip);
    else if (r?.warn) record(name, 'WARN', r.warn);
    else record(name, 'PASS', typeof r === 'string' ? r : '');
  } catch (e) {
    record(name, 'FAIL', String(e?.message ?? e).split('\n')[0].slice(0, 300));
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sh = (cmd, opts = {}) => spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });
const tail = (s) => String(s ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.LEDGER_FILE; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
const killAll = () => { for (const p of procs) { try { p.kill(); } catch { /* already gone */ } } };
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(130); });

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startNode(script, env, upUrl) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (child.exitCode !== null) throw new Error(`${script} exited early: ${tail(out)}`);
    try { await fetch(upUrl, { signal: AbortSignal.timeout(1000) }); return { child, out: () => out }; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`${script} did not start in time: ${tail(out)}`);
}

const parseMaybeSse = (txt) => {
  try { return JSON.parse(txt); } catch { /* maybe SSE */ }
  const line = txt.split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error('unparseable MCP response: ' + txt.slice(0, 120));
  return JSON.parse(line.slice(5).trim());
};

// ---------- static / repo checks ----------
await check('Node version is 20 or newer', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert(major >= 20, `Node ${process.versions.node}`);
  return `Node ${process.versions.node}`;
});

await check('Every JS file parses (node --check)', () => {
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) files.push(p);
    }
  };
  ['src', 'scripts', 'eval', 'test'].forEach(walk);
  const bad = files.filter((f) => spawnSync(process.execPath, ['--check', f]).status !== 0);
  assert(!bad.length, 'syntax errors in: ' + bad.join(', '));
  return `${files.length} files`;
});

const inGit = sh('git rev-parse --is-inside-work-tree').stdout?.trim() === 'true';

await check('.env is not tracked and results are ignored', () => {
  if (!inGit) return { skip: 'not a git repository' };
  assert(!sh('git ls-files .env').stdout.trim(), '.env is tracked by git');
  assert(sh('git check-ignore -q .env').status === 0, '.env is not in .gitignore');
  assert(sh('git check-ignore -q eval/results/x.txt').status === 0, 'eval/results/ is not ignored');
});

await check('No secrets in files that would be committed', () => {
  if (!inGit) return { skip: 'not a git repository' };
  const files = sh('git ls-files -co --exclude-standard').stdout.split('\n').filter(Boolean);
  // Real key shapes are flagged anywhere. "NAME=value" lines are flagged only when the value is not an obvious placeholder.
  const shapes = [/ABSK[A-Za-z0-9+/=]{20,}/, /AKIA[0-9A-Z]{16}/];
  const assignment = /(?:AWS_BEARER_TOKEN_BEDROCK|MCP_AUTH_TOKEN)[ \t]*=[ \t]*['"]?([^\s#'"]{8,})/g;
  const placeholder = /^(<|\$\{|\.\.\.)|your|change|replace|example|placeholder|xxx|todo|secret-here|random/i;
  const hits = [];
  for (const f of files) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|mp3|wav|m4a)$/i.test(f)) continue;
    let text;
    try { if (fs.statSync(f).size > 2_000_000) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const realAssignment = [...text.matchAll(assignment)].some((m) => !placeholder.test(m[1]));
    if (shapes.some((p) => p.test(text)) || realAssignment) hits.push(f);
  }
  assert(!hits.length, 'possible real secret in: ' + hits.join(', '));
  return `${files.length} files scanned`;
});

await check('LICENSE, .env.example and README run instructions exist', () => {
  assert(fs.existsSync('LICENSE'), 'LICENSE missing');
  assert(fs.existsSync('.env.example'), '.env.example missing');
  assert(fs.existsSync('README.md'), 'README.md missing');
  const readme = fs.readFileSync('README.md', 'utf8');
  const missing = ['npm test', 'npm run mcp', 'INTERPRETER'].filter((s) => !readme.includes(s));
  if (missing.length) return { warn: 'README does not mention: ' + missing.join(', ') };
});

await check('Working tree is committed and eval cases are frozen', () => {
  if (!inGit) return { skip: 'not a git repository' };
  const frozen = sh('git status --porcelain -- eval/cases.json eval/cases.holdout.json eval/cases.holdout2.json').stdout.trim();
  assert(!/^\s*M/m.test(frozen), 'eval case files have uncommitted edits');
  const dirty = sh('git status --porcelain').stdout.trim();
  if (dirty) return { warn: `${dirty.split('\n').length} uncommitted change(s)` };
});

await check('.gitattributes exists (line-ending warnings)', () => {
  if (!fs.existsSync('.gitattributes')) return { warn: 'missing; add a file containing: * text=auto' };
});

// ---------- unit tests + prompt hygiene ----------
await check('Unit tests (npm test)', () => {
  const r = sh('npm test');
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  const pass = Number(/(?:#|ℹ)\s*pass\s+(\d+)/.exec(text)?.[1] ?? NaN);
  const fail = Number(/(?:#|ℹ)\s*fail\s+(\d+)/.exec(text)?.[1] ?? NaN);
  assert(r.status === 0 && fail === 0, `npm test failed: ${tail(text)}`);
  return `${pass} passed`;
});

await check('No eval phrase leaked into the interpreter prompt', () => {
  if (!fs.existsSync('scripts/check-leak.mjs')) return { skip: 'scripts/check-leak.mjs missing' };
  const r = sh(`"${process.execPath}" scripts/check-leak.mjs`);
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  assert(!/LEAK \[/.test(text), 'full eval sentence found in prompt');
  const bad = ['mia tano', 'mia mbili', 'amelipa mia', 'pagou duzentos', 'catat utang', 'dice que', 'bol raha hai', 'sudah bayar']
    .filter((p) => text.includes(`"${p}"`));
  assert(!bad.length, 'specific eval phrases in prompt: ' + bad.join(', '));
  const generic = new Set(['hai usne']);
  const shared = [...text.matchAll(/^\s+"([^"]+)"\s+<-/gm)].map((m) => m[1]).filter((p) => !generic.has(p));
  if (shared.length) return { warn: 'review these phrases shared with eval sentences: ' + shared.join(', ') };
});

for (const [label, file] of [['dev', 'eval/cases.json'], ['holdout v1', 'eval/cases.holdout.json'], ['holdout v2', 'eval/cases.holdout2.json']]) {
  await check(`Mock-interpreter eval keeps the ledger consistent (${label})`, () => {
    if (!fs.existsSync(file)) return { skip: `${file} missing` };
    const r = sh(`"${process.execPath}" eval/run.js`, { env: cleanEnv({ INTERPRETER: 'mock', CASES: file }) });
    const text = (r.stdout ?? '') + (r.stderr ?? '');
    const m = /(\d+)\/(\d+) cases passed/.exec(text);
    const inv = /invariant violations:\s*(\d+)/.exec(text);
    assert(m && inv, 'could not parse eval output: ' + tail(text));
    assert(Number(inv[1]) === 0, `${inv[1]} invariant violations`);
    return `rules-only baseline ${m[1]}/${m[2]} (informational), 0 invariant violations`;
  });
}

// ---------- API end to end (mock interpreter, in-memory ledger) ----------
await check('API: propose -> bad digest -> approve -> stale yes -> payment -> dispute', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startNode('src/api/server.js', cleanEnv({ PORT: String(port), INTERPRETER: 'mock' }), `${base}/customers`);
  try {
    const session = `verify-${Date.now()}`;
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-session': session }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    };
    const say = (t) => call('POST', '/utterance', { transcript: t });
    const customers = await call('GET', '/customers');
    const raju = customers.find((c) => c.name === 'Raju');
    assert(raju, 'seeded customer Raju missing');
    const ledger = async () => (await call('GET', `/customers/${raju.id}/ledger`)).ledger;
    const audit = async () => call('GET', `/customers/${raju.id}/audit`);
    const start = (await ledger()).balance;

    const open = await call('POST', '/session/open');
    assert(open && typeof open === 'object', 'session/open returned nothing');

    const r1 = await say('Raju ko 500 rupaye udhaar likh do, dal 500 ka.');
    const p = r1.proposal;
    const pid = p?.id ?? p?.proposalId;
    assert(pid && p?.digest, 'no proposal id/digest in the reply');
    assert((await ledger()).balance === start, 'a proposal wrote to the ledger');

    const bad = await call('POST', `/proposals/${pid}/approve`, { digest: '000000000000' });
    assert(bad.ok === false, 'wrong digest was accepted');
    assert((await ledger()).balance === start, 'wrong digest changed the balance');

    const good = await call('POST', `/proposals/${pid}/approve`, { digest: p.digest });
    assert(good.ok === true, 'correct digest was refused');
    assert((await ledger()).balance === start + 500, 'balance did not rise by 500');

    const before = (await audit()).length;
    await say('Haan.');
    assert((await ledger()).balance === start + 500 && (await audit()).length === before, 'a stale "yes" wrote something');

    await say('Raju ne 200 rupaye diye.');
    await say('Haan.');
    assert((await ledger()).balance === start + 300, 'payment did not reduce balance by 200');

    await say('Raju bol raha hai usne 300 rupaye de diye the.');
    await say('Haan.');
    const l = await ledger();
    const events = await audit();
    assert(l.status === 'DISPUTED', `status is ${l.status}, expected DISPUTED`);
    assert(l.balance === start + 300, 'dispute changed the balance');
    assert(events.filter((e) => e.type === 'PAYMENT_RECEIVED').length === 1, 'dispute created a payment');
    return 'credit, digest gate, stale yes, payment, dispute';
  } finally { srv.child.kill(); }
});

// ---------- MCP end to end ----------
await check('MCP: auth, protocol 2025-11-25, tools, propose/approve gate', async () => {
  assert(fs.existsSync('src/mcp/ledger.js'), 'src/mcp/ledger.js missing');
  const port = await freePort();
  const token = 'verify-token-' + Date.now();
  const url = `http://127.0.0.1:${port}/mcp`;
  const srv = await startNode('src/mcp/ledger.js', cleanEnv({ MCP_PORT: String(port), PORT: String(port), MCP_AUTH_TOKEN: token }), url);
  try {
    const hdr = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } });
    const noAuth = await fetch(url, { method: 'POST', headers: hdr, body: init });
    assert(noAuth.status === 401, `request without token returned ${noAuth.status}, expected 401`);
    const withAuth = await fetch(url, { method: 'POST', headers: { ...hdr, authorization: `Bearer ${token}` }, body: init });
    const json = parseMaybeSse(await withAuth.text());
    assert(json.result?.protocolVersion === '2025-11-25', `negotiated ${json.result?.protocolVersion}`);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'verify', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      const need = ['list_customers', 'get_balance', 'list_overdue', 'get_audit', 'propose_credit', 'propose_payment', 'propose_correction', 'propose_dispute', 'approve_proposal', 'reject_proposal'];
      const missing = need.filter((n) => !names.includes(n));
      assert(!missing.length, 'missing tools: ' + missing.join(', '));

      const out = (r) => r.structuredContent ?? JSON.parse(r.content.find((c) => c.type === 'text').text);
      const balance = async () => out(await client.callTool({ name: 'get_balance', arguments: { customerName: 'Raju' } })).ledger.balance;
      const start = await balance();

      const prop = await client.callTool({ name: 'propose_credit', arguments: { customerName: 'Raju', amount: 100, items: [{ name: 'tea', totalAmount: 100 }] } });
      const pj = out(prop);
      assert(pj.proposalId && pj.digest, 'propose_credit returned no proposalId/digest');
      assert(await balance() === start, 'propose_credit wrote to the ledger');

      const bad = await client.callTool({ name: 'approve_proposal', arguments: { proposalId: pj.proposalId, digest: '000000000000' } });
      assert(bad.isError === true || out(bad).ok === false, 'wrong digest was accepted');
      assert(await balance() === start, 'wrong digest changed the balance');

      const good = await client.callTool({ name: 'approve_proposal', arguments: { proposalId: pj.proposalId, digest: pj.digest } });
      assert(!good.isError && out(good).ok === true, 'correct digest was refused');
      assert(await balance() === start + 100, 'balance did not rise by 100');

      const es = out(await client.callTool({ name: 'propose_payment', arguments: { customerName: 'Raju', amount: 40, language: 'es' } }));
      assert(!/Shall I|Record/.test(es.readBack ?? ''), 'language "es" did not localize the readBack: ' + es.readBack);
      const rej = await client.callTool({ name: 'reject_proposal', arguments: { proposalId: es.proposalId } });
      assert(!rej.isError, 'reject_proposal failed');
      assert(await balance() === start + 100, 'a rejected proposal changed the balance');

      const amb = await client.callTool({ name: 'get_balance', arguments: { customerName: 'Nobody' } });
      assert(amb.isError === true, 'unknown customer did not return isError');
    } finally { await client.close(); }
    return `protocol 2025-11-25, auth enforced, 10 tools, digest gate enforced`;
  } finally { srv.child.kill(); }
});

// ---------- web build ----------
await check('Web simulator builds (web/ npm run build)', () => {
  const web = path.join(ROOT, 'web');
  if (!fs.existsSync(path.join(web, 'package.json'))) return { skip: 'web/ not present' };
  if (!fs.existsSync(path.join(web, 'node_modules'))) {
    const i = sh(fs.existsSync(path.join(web, 'package-lock.json')) ? 'npm ci' : 'npm install', { cwd: web });
    assert(i.status === 0, 'web install failed: ' + tail(i.stderr || i.stdout));
  }
  const b = sh('npm run build', { cwd: web });
  assert(b.status === 0, 'web build failed: ' + tail(b.stderr || b.stdout));
});

// ---------- optional live model ----------
await check('Live Bedrock interpreter returns correct intents (--llm)', async () => {
  if (!WITH_LLM) return { skip: 'not requested (add --llm and run with --env-file=.env)' };
  assert(process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.AWS_REGION && process.env.BEDROCK_MODEL_ID, 'AWS_BEARER_TOKEN_BEDROCK / AWS_REGION / BEDROCK_MODEL_ID not set');
  const { interpretLLM } = await import(pathToFileURL(path.join(ROOT, 'src/ai/interpret.llm.js')).href);
  const ctx = { customers: ['Raju', 'Amit', 'Suresh'], lastCustomer: 'Raju' };
  const credit = await interpretLLM('Raju ne 500 ka tel udhaar liya', ctx);
  assert(credit.intent === 'RECORD_CREDIT' && credit.customerName === 'Raju' && credit.amount === 500, 'credit parsed as ' + JSON.stringify(credit));
  const pay = await interpretLLM('Amit ne 200 rupaye diye', ctx);
  assert(pay.intent === 'RECORD_PAYMENT' && pay.amount === 200, 'payment parsed as ' + JSON.stringify(pay));
  return `model ${process.env.BEDROCK_MODEL_ID}`;
});

// ---------- verdict ----------
killAll();
const count = (s) => results.filter((r) => r.status === s).length;
console.log('\n=== SUMMARY ===');
console.log(`${count('PASS')} passed, ${count('FAIL')} failed, ${count('WARN')} warnings, ${count('SKIP')} skipped`);
for (const r of results.filter((x) => x.status === 'WARN' || x.status === 'SKIP')) console.log(`  ${r.status}: ${r.name} - ${r.detail}`);
if (count('FAIL')) {
  console.log('\nNOT READY. Failed checks:');
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  - ${r.name}: ${r.detail}`);
  process.exitCode = 1;
} else {
  console.log('\nALL AUTOMATED CHECKS PASSED - the app is functional within the scope above.');
  console.log('Not covered by this script: live Bedrock quality (run the eval; use --llm for a 2-sentence check), a physical Alexa+ device,');
  console.log('the web UI by eye (voice input, confirm card), and the demo video.');
}
