import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import * as browser from './browser.js';

const token = process.env.MCP_TOKEN || '';
if (process.env.NODE_ENV === 'production' && !token) {
  throw new Error('MCP_TOKEN is required in production.');
}

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

function authorized(req, res, next) {
  if (!token) return next();
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function result(data) { return { content: [{ type: 'text', text: JSON.stringify(data) }] }; }
function withBrowser(fn) {
  return async args => {
    try { return result(await browser.exclusive(() => fn(args))); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
}

function getServer() {
  const server = new McpServer({ name: 'sala-do-futuro-remote', version: '0.1.0' });
  server.registerTool('open_session', { description: 'Open the headless Sala do Futuro browser and report login state.', inputSchema: {} }, withBrowser(browser.openSession));
  server.registerTool('bootstrap_login', { description: 'One-time student login. Credentials are used only for this call and are not stored; encrypted browser state is persisted.', inputSchema: { ra: z.string().min(1), digit: z.string().min(1), password: z.string().min(1) } }, withBrowser(browser.bootstrapLogin));
  server.registerTool('direct_login', { description: 'Authenticate through the official SEDUC-SP API without opening a visible window. Retains the token in process memory; does not store the password.', inputSchema: { ra: z.string().min(1), digit: z.string().min(1), uf: z.string().length(2), password: z.string().min(1) } }, withBrowser(browser.directLogin));
  server.registerTool('api_session_status', { description: 'Report whether direct API authentication is available, without revealing credentials or tokens.', inputSchema: {} }, withBrowser(browser.apiSessionStatus));
  server.registerTool('diagnose_task_api', { description: 'Check whether the official task API accepts the current SED session from this server; returns only status metadata.', inputSchema: {} }, withBrowser(browser.diagnoseTaskApi));
  server.registerTool('diagnose_sed_task_token', { description: 'Test the official SED task integration token endpoint with available login token variants; never returns token values.', inputSchema: {} }, withBrowser(browser.diagnoseSedTaskToken));
  server.registerTool('inspect_task_gateway', { description: 'Open the task integration in this Render Chromium session and inspect a possible security challenge. Returns redacted metadata and a screenshot.', inputSchema: {} }, async () => {
    try {
      const data = await browser.exclusive(browser.inspectTaskGateway);
      return { content: [{ type: 'text', text: JSON.stringify(data.metadata) }, { type: 'image', data: data.screenshot, mimeType: 'image/png' }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('wait_task_gateway', { description: 'Wait on the existing remote integration page without reloading it, then inspect its state.', inputSchema: { seconds: z.number().int().min(1).max(30).optional() } }, async args => {
    try {
      const data = await browser.exclusive(() => browser.waitTaskGateway(args));
      return { content: [{ type: 'text', text: JSON.stringify(data.metadata) }, { type: 'image', data: data.screenshot, mimeType: 'image/png' }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('navigate_to', { description: 'Navigate within the official Sala do Futuro origin.', inputSchema: { url: z.string().min(1) } }, withBrowser(({ url }) => browser.navigate(url)));
  server.registerTool('scan_environment', { description: 'Map visible interactive elements to temporary IDs.', inputSchema: {} }, withBrowser(browser.scan));
  server.registerTool('extract_content', { description: 'Extract visible activity text, question candidates and media metadata.', inputSchema: {} }, withBrowser(browser.extract));
  server.registerTool('capture_view', { description: 'Capture the visible page as a PNG image.', inputSchema: {} }, async () => {
    try { return { content: [{ type: 'image', data: await browser.exclusive(browser.capture), mimeType: 'image/png' }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('execute_action', { description: 'Click, fill or select an element from the current interaction map.', inputSchema: { revision: z.number().int(), target_id: z.string(), action: z.enum(['click', 'fill', 'select']), value: z.string().optional() } }, withBrowser(browser.action));
  server.registerTool('submit_activity', { description: 'Submit an activity using its mapped final button.', inputSchema: { revision: z.number().int(), target_id: z.string() } }, withBrowser(browser.submit));
  server.registerTool('verify_submission', { description: 'Check visible evidence of success or error.', inputSchema: {} }, withBrowser(browser.verify));
  return server;
}

app.post('/mcp', authorized, async (req, res) => {
  const server = getServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.once('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error?.message || error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});
app.get('/mcp', authorized, (_req, res) => res.status(405).end());
app.delete('/mcp', authorized, (_req, res) => res.status(405).end());

const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.error(`MCP listening on ${port}`));



