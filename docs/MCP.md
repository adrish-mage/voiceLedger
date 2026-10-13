# Ledger MCP Server

Run the Streamable HTTP MCP server with:

```sh
npm run mcp
```

It listens at `http://localhost:3001/mcp` by default. Set `MCP_PORT` to change the port and `LEDGER_FILE` to persist customers and events using the same JSONL store as the API. The demo customer is seeded unless `SEED_DEMO=0`. Set `MCP_AUTH_TOKEN` to require `Authorization: Bearer <token>` on POST requests. Requests with an `Origin` header are rejected unless that exact origin appears in the comma-separated `MCP_ALLOWED_ORIGINS` value; by default, no origins are allowed.

## Tools

- `list_customers`: list customer IDs and names.
- `get_balance`: read the ledger and balance for a uniquely matched customer.
- `list_overdue`: list overdue accounts.
- `get_audit`: read a customer's audit history.
- `propose_credit`: propose credit, optionally with item details and a due date.
- `propose_payment`: propose a payment.
- `propose_correction`: propose an item amount correction.
- `propose_dispute`: propose opening a dispute.
- `approve_proposal`: commit a pending proposal using its digest.
- `reject_proposal`: reject a pending proposal.

Proposal tools do not write ledger events. Read the returned `readBack` text to the user and wait for an explicit yes before calling `approve_proposal`; pass the exact returned digest. A customer name must resolve to exactly one match.

## HTTPS Tunnel

For a temporary HTTPS endpoint, install and authenticate `cloudflared`, then run:

```sh
cloudflared tunnel --url http://localhost:3001
```

Use the HTTPS URL printed by cloudflared with the `/mcp` path. If the MCP client sends an `Origin` header, add its exact origin to `MCP_ALLOWED_ORIGINS`. Keep `MCP_AUTH_TOKEN` enabled for any endpoint exposed beyond your machine and configure the client to send the bearer token.

## Inspector

With the server running, launch the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector
```

Connect it to the Streamable HTTP transport at `http://localhost:3001/mcp`. Configure the bearer token in the Inspector when `MCP_AUTH_TOKEN` is set. To verify the integration tests, run `npm test`.