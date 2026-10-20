# Voice Ledger

Voice Ledger is a voice credit book for small merchants, in any language: a shopkeeper speaks naturally, reviews a proposed transaction, and keeps a reliable record without stopping to write. **The AI proposes; the application owns the books.**

## Architecture

```mermaid
flowchart LR
  A[Voice] --> B[Speech-to-text]
  B --> C[LLM interpreter]
  C --> D[Schema validation]
  D --> E[Agent proposal]
  E --> F{User says yes}
  F -->|Approved| G[Append-only event log]
  G --> H[Derived balances]
```

## Prerequisites

- Node.js 20 or newer and npm.
- For the LLM-backed API and LLM evaluations: Amazon Bedrock access, an AWS bearer token, region, and model ID. The mock interpreter and ledger tests do not require Bedrock.
- Speech-to-text is an upstream input to this prototype; the eval harness evaluates transcripts, not audio.

## Quick start (no AWS key needed)

Clone the repository and install dependencies:

```sh
git clone https://github.com/adrish-mage/voiceLedger.git
cd voiceLedger
npm ci
cp .env.example .env
```

Start the API from the repository root. With `INTERPRETER` unset, it uses the mock interpreter and does not need AWS credentials:

```sh
npm run dev
```

In another terminal, start the web simulator:

```sh
cd web
npm ci
npm run dev
```

In another terminal at the repository root, start the MCP server:

```sh
npm run mcp
```

Run the verification suite from the repository root (in a separate terminal):

```sh
npm run verify
```

`npm test` runs the unit tests. For the optional Bedrock-backed interpreter, configure the AWS and model settings in `.env`, set `INTERPRETER=llm`, then use `npm run dev:llm` or `npm run verify:llm`.

### Evaluations

The development set was used for prompt tuning, mostly against GLM failures. The holdout set was written before tuning and was never used to tune. `scripts/check-leak.mjs` verifies that no full evaluation sentence appears in the model prompt. The holdout is the headline accuracy; development results are for tuning and comparison.

## Evaluation results

Each LLM row reports the three recorded runs in `eval/results/*.txt`. Invariant violations and extra-write cases are totals across those runs. Per-run elapsed times were not recorded in those files. The mock baseline is a fresh rules-only run on each set.

| Interpreter / set | Run 1 cases passed | Run 2 cases passed | Run 3 cases passed | Range | Invariant violations total | Extra-write cases total | Seconds per run (1 / 2 / 3) |
|---|---:|---:|---:|---:|---:|---:|---|
| Mock / dev (27 cases) | 15/27 | not run | not run | 15-15 | 0 | 0 | not run / not run / not run |
| GLM 4.7 Flash / dev (27 cases) | 23/27 | 24/27 | 23/27 | 23-24 | 0 | 0 | not run / not run / not run |
| gpt-oss-20b / dev (27 cases) | 27/27 | 25/27 | 27/27 | 25-27 | 0 | 0 | not run / not run / not run |
| Mock / holdout (16 cases) | 5/16 | not run | not run | 5-5 | 0 | 0 | not run / not run / not run |
| GLM 4.7 Flash / holdout (16 cases) | 12/16 | 12/16 | 12/16 | 12-12 | 0 | 0 | not run / not run / not run |
| gpt-oss-20b / holdout (16 cases) | 13/16 | 12/16 | 13/16 | 12-13 | 0 | 0 | not run / not run / not run |

### How to reproduce

Run from the repository root in PowerShell. The mock commands reproduce the rules-only baseline. For LLM runs, put the corresponding Bedrock model ID and AWS settings in `.env`; execute each LLM command three times to collect three runs.

```powershell
# Rules-only mock baseline: dev, then holdout
$env:INTERPRETER = 'mock'
$env:CASES = 'eval/cases.json'
node eval/run.js
$env:CASES = 'eval/cases.holdout.json'
node eval/run.js

# LLM: set BEDROCK_MODEL_ID in .env to GLM 4.7 Flash or gpt-oss-20b,
# then run each dataset command three times per model
$env:INTERPRETER = 'llm'
$env:CASES = 'eval/cases.json'
node --env-file=.env eval/run.js
$env:CASES = 'eval/cases.holdout.json'
node --env-file=.env eval/run.js
```

## Safety design

The model only interprets the transcript into a schema-validated intent. It never writes events, approves a proposal, or computes a balance. The application creates the proposal; approval is bound to the exact proposal content by a digest, and only the approval path can append an event. Balances are derived by replaying the append-only event log. Ledger invariants are checked in tests and evaluations; the target and reported safety result is **0 invariant violations**.

## Ledger invariants

1. Balance is derived by replaying the event log, never stored. Two independent computations must agree.
2. Events are immutable. A correction is a new event pointing at the original.
3. A correction must reference an existing credit.
4. A dispute contributes zero to the balance. A claim is never turned into a payment.
5. Nothing is written without `approve()`. Corrections and dispute resolution require the proposal digest.
6. Committed content hashes to the approved content, and a dry-run replay happens before every write.
7. Payments are allocated oldest-credit-first (FIFO). The due date is the earliest unpaid credit.
8. Overdue is computed by code from the past-due unpaid amount, excluding disputed amounts.

## Project map

| File | Purpose |
|---|---|
| `src/ledger/reducer.js` | Replays events into balances, FIFO allocation, disputes, and overdue status. |
| `src/ledger/approval.js` | Approval tiers and digest binding. |
| `src/ledger/service.js` | Proposals and approvals; the only path that writes events. |
| `src/ledger/store.js` | Append-only in-memory or JSONL event store. |
| `src/ai/schema.js` | Validated JSON contract for interpreter output. |
| `src/ai/interpret.llm.js` | Bedrock interpreter prompt and response handling. |
| `eval/run.js` | Transcript evaluation harness and invariant checks. |

## Known limitations

- Swahili dispute phrasing is unreliable on small models; the application fails safe.
- Item names that match the alias list are shown in English in replies.
- Single shop; no login.
- Currency amounts use whole units only.
- Non-English reply templates have not been reviewed by native speakers.
- Not verified on a physical Alexa+ device; tested only with the MCP Inspector and a web simulator.

## License

MIT (see LICENSE).

## Map of the code

| File | What it is | Who should own it |
|---|---|---|
| `src/ledger/reducer.js` | Replays events → balance, FIFO allocation, disputes, overdue. Pure function. | **You (read line by line)** |
| `src/ledger/approval.js` | Approval tiers + digest binding an approval to exact content | **You** |
| `src/ledger/service.js` | `propose*()` then `approve()`. The only code path that writes events | **You** |
| `src/ledger/store.js` | Append-only store (memory or JSONL file). Events are deep-frozen | AI-generated is fine; swap for MongoDB later |
| `src/ledger/validate.js` | Input validation | review |
| `src/agent.js` | Transcript → intent → proposal → "haan" → approve. Holds conversation state | review |
| `src/ai/schema.js` | The JSON contract the LLM must return, validated by hand | **You** |
| `src/ai/interpret.mock.js` | Rule-based stand-in for the AI. Only knows demo phrasings | throwaway |
| `src/ai/interpret.llm.js` | Prompt + skeleton. **This is where real AI integration goes (Day 2)** | you + AI |
| `src/api/server.js` | HTTP API for the simulator | AI-generated is fine |
| `src/mcp/hello.js` | Hello-world MCP server for the Alexa+ connection test | AI-generated is fine |
| `eval/run.js` | Eval harness (cases → pass/fail + invariant violations) | **You** |

## Ledger invariants (enforced in code, tested)

1. Balance is derived by replaying the event log, never stored. Two independent computations must agree.
2. Events are immutable. A correction is a new event pointing at the original.
3. A correction must reference an existing credit.
4. A dispute contributes ₹0 to the balance, always. A claim is never turned into a payment.
5. Nothing is written without `approve()`. Corrections and dispute resolution need the proposal digest (FULL_APPROVAL).
6. What gets committed hashes to what was approved (Invariant 7), and a dry-run replay happens before every write.
7. Payments are allocated oldest-credit-first (FIFO). Due date = earliest unpaid credit.
8. Overdue = past due date and unpaid, minus the disputed amount. Computed by code. The LLM never decides it.

## What "AI integration" means here

One function: `interpret(transcript, context) → intent JSON`. The model reads speech-as-text and returns a small
JSON object (`src/ai/schema.js`). The app validates it; anything invalid is treated as "didn't understand".
The model never touches money. See the steps at the top of `src/ai/interpret.llm.js`.

## Known gaps (decide, don't forget)

- Whole rupees only (no paise yet).
- The mock interpreter only understands the demo phrasings.
- In a fresh session, a correction without naming the customer asks "Kis customer ke liye?" (safe, but decide if it should infer).
- Opening a dispute is QUICK_CONFIRM per the plan, so the demo needs one extra "Haan" there.
- FIFO allocates by total payments; it does not model a payment made before a later credit.
- Customer matching is exact/prefix only, no fuzzy matching.
- Only the hello-world MCP server exists. The 8 real tools are not wrapped yet.
- **Alexa+ connection is UNVERIFIED.** The hello server completed a local MCP handshake reporting protocol 2025-11-25.
  That says nothing about Alexa+ reaching it.Submission path: self-hosted MCP server plus Alexa-style simulator. Direct Alexa+ device connection not achieved (UNVERIFIED).
- No authentication; single shop owner.

## License
MIT (see LICENSE). Edit the copyright line to your full legal name.
