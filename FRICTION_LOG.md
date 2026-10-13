# FRICTION_LOG.md

Real friction only. Never rewrite an entry to hide a failure. (Friction logs earn up to a 10% judging bonus.)

Format per entry:
- **Date / tool**
- **Task attempted**
- **Expected vs actual**
- **Severity** (blocker / major / minor)
- **Workaround**
- **Suggestion**

## Entries

### Bedrock playground retained earlier assistant messages
- **Date / tool:** Date not recorded / Amazon Bedrock playground, View API request.
- **Task attempted:** Clear the playground chat and send a fresh prompt while debugging a model response.
- **Steps:** Send a prompt, clear the chat, send another prompt, then inspect the request in View API.
- **Expected vs actual:** Expected the next request to contain only the new conversation; the API request still included earlier assistant messages.
- **Severity:** Major; stale context can contaminate prompt experiments and observed results.
- **Workaround:** Start a new playground session and inspect each View API request before treating a run as clean.
- **Suggestion:** Make clearing chat reset the messages included in subsequent API requests, or clearly distinguish clearing the visible transcript from resetting request history.

### Small model copied items from a hint list
- **Date / tool:** Date not recorded / small-model LLM interpreter evaluation.
- **Task attempted:** Interpret a spoken credit transaction while supplying item hints in the prompt context.
- **Steps:** Run a case whose utterance did not name an item, with a hint list containing item names; inspect the structured output.
- **Expected vs actual:** Expected item names only when spoken; the model injected items from the hint list into its output.
- **Severity:** Major; invented transaction details can make a proposal incorrect.
- **Workaround:** Treat hints as untrusted, validate output against the utterance and schema, and leave items empty when not explicitly stated.
- **Suggestion:** Keep hint data out of the extraction context unless needed, and add adversarial eval cases that ensure unspoken items are never emitted.

### gpt-oss returned reasoning only at low maxTokens
- **Date / tool:** Date not recorded / gpt-oss-20b on Amazon Bedrock.
- **Task attempted:** Get a structured intent response with a low `maxTokens` limit.
- **Steps:** Send the same interpreter request with a low token cap; inspect the response content and `stopReason`.
- **Expected vs actual:** Expected the final JSON object; Bedrock returned only a reasoning block and `stopReason: max_tokens`.
- **Severity:** Major; no usable intent reaches schema validation.
- **Workaround:** Increase `maxTokens` enough for reasoning and the final answer, then verify that the response includes a text block.
- **Suggestion:** Document model-specific token requirements and detect `max_tokens` truncation explicitly in the interpreter and evaluation output.

### Alexa AI CLI install returned E404
- **Date / tool:** 2026-10-05 / npm.
- **Task attempted:** Install the Alexa AI CLI to register a hello-world MCP server with Alexa+.
- **Steps:** Run `npm install -g @alexa-ai/cli` against the public npm registry.
- **Expected vs actual:** Expected the CLI to install; npm returned E404 because the package is in a private AWS CodeArtifact registry requiring an AWS IAM role.
- **Severity:** Major; blocks the real-device path. Setup docs say tooling arrives after approval, but the hackathon rules do not mention the CLI or approval.
- **Workaround:** Use the simulator path.
- **Suggestion:** State the access requirement in the hackathon Alexa+ track instructions.
