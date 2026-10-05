// Day-1 hello-world MCP server over Streamable HTTP (stateless).
// Goal of the 3-hour time-box: can Alexa+ reach and call this? Run it, expose it
// over HTTPS (ngrok/cloudflared), and try to register it with Alexa+.
// What counts as "connected" is UNVERIFIED until you demonstrate it.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function buildServer() {
  const server = new McpServer({ name: 'voice-ledger-hello', version: '0.0.1' });
  server.registerTool(
    'ping',
    { description: 'Echo a message back. Used to test connectivity.', inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: 'text', text: `pong: ${message}` }] }),
  );
  return server;
}

const app = express();
app.use(express.json());
app.post('/mcp', async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST /mcp' }));

const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`hello MCP on http://localhost:${port}/mcp`));
