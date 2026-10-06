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
(none yet)
   ## Alexa AI CLI install - 2026-10-05
   - Task: install the Alexa AI CLI to register a hello-world MCP server with Alexa+.
   - Tried: `npm install -g @alexa-ai/cli` -> E404 from public npm.
   - Cause: the package is in a private AWS CodeArtifact registry that needs an AWS IAM role.
   - Setup docs say tooling arrives after approval; the hackathon rules never mention the CLI or approval.
   - Severity: major (blocks the real-device path). Workaround: simulator path.
   - Suggestion: state the access requirement in the hackathon Alexa+ track instructions. npm.
