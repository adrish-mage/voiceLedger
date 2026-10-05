# voice-ledger (working name — pick a product name this week)

A voice-first Hinglish credit book for hands-busy small-business owners.
**The AI proposes. The application owns the books.**

Amazon Developer Hackathon 2026 · Alexa+ track · solo build.

```
VOICE → STT → LLM interpretation → proposal → validation → approval
      → append-only event → derived balance → recovery (correct / dispute / overdue)
```

## Quick start

```bash
npm install
npm test          # 17 tests: ledger rules, approval gate, random-operation invariants, full demo story
npm run demo      # the whole demo conversation through the real pipeline (no AI needed)
npm run eval      # text-level eval harness on eval/cases.sample.json
npm run dev       # HTTP API on :3000 (build the Alexa-style simulator UI against this)
npm run mcp:hello # Day-1 hello-world MCP server on :3001/mcp (Streamable HTTP)
```

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
  That says nothing about Alexa+ reaching it.
- No authentication; single shop owner.

## License
MIT (see LICENSE). Edit the copyright line to your full legal name.
