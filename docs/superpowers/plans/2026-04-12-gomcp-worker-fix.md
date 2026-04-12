# gomcp-worker Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gomcp-worker` deployable and fix the broken MCP/CDP/SSE paths without turning `main` into a smoking crater.

**Architecture:** Keep the existing Worker + Durable Object + CDP shape, but narrow responsibilities. The Worker owns lightweight SSE handshake responses, while the Durable Object only owns MCP session state and browser-backed tool execution. Extract CDP `Runtime.evaluate` value parsing into a small helper so tool behavior is consistent and testable.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Web Streams API, Wrangler, Vitest

---

## File Structure

### Files to modify
- `package.json` — add test script and Vitest dev dependency.
- `README.md` — align docs with the repaired behavior and deployment requirements.
- `wrangler.toml` — add Durable Object migration.
- `src/index.ts` — move SSE response creation into the Worker and keep MCP POST/DELETE behavior.
- `src/mcp/session.ts` — remove SSE writer state, delay CDP connection until `tools/call`, use shared evaluate helper, fix navigation listener cleanup.
- `src/types/mcp.ts` — add a concrete page link type and use it consistently.

### Files to create
- `vitest.config.ts` — minimal Vitest configuration.
- `src/mcp/eval.ts` — helper to extract `Runtime.evaluate` values safely.
- `tests/mcp/eval.test.ts` — unit tests for CDP evaluate value extraction.
- `tests/worker/sse.test.ts` — unit tests for lightweight SSE response creation.

### Files intentionally not changing
- `src/cdp/client.ts` — keep current WebSocket client shape; this plan only relies on its existing `on/off/send/isConnected` behavior.
- `src/tools/index.ts` — keep tool registry and tool signatures stable.

---

### Task 1: Add a test harness for the repair work

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Write the failing test command by adding a test script and dependency references**

Update `package.json` to:

```json
{
  "name": "gomcp-worker",
  "version": "1.0.0",
  "description": "Cloudflare Workers implementation of gomcp (MCP Server for Lightpanda Browser)",
  "main": "src/index.ts",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@cloudflare/workers-types": "^4.20250121.0",
    "turndown": "^7.2.0"
  },
  "devDependencies": {
    "@types/turndown": "^5.0.5",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8",
    "wrangler": "^3.107.0"
  }
}
```

- [ ] **Step 2: Add a minimal Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      enabled: false,
    },
  },
});
```

- [ ] **Step 3: Run the empty test suite to verify the harness is wired**

Run:

```bash
npm install
npm run test
```

Expected: Vitest starts successfully and reports no test files or zero tests, which is fine at this stage because we have only installed the harness.

- [ ] **Step 4: Commit the harness setup**

```bash
git add package.json vitest.config.ts package-lock.json
git commit -m "test: add vitest harness"
```

---

### Task 2: Add a shared helper for CDP `Runtime.evaluate` values

**Files:**
- Create: `src/mcp/eval.ts`
- Test: `tests/mcp/eval.test.ts`

- [ ] **Step 1: Write the failing tests for nested CDP values and null-safe fallback**

Create `tests/mcp/eval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getEvaluateValue } from '../../src/mcp/eval';

describe('getEvaluateValue', () => {
  it('returns the nested Runtime.evaluate value', () => {
    const response = {
      id: '1',
      result: {
        result: {
          type: 'string',
          value: 'hello',
        },
      },
    };

    expect(getEvaluateValue(response)).toBe('hello');
  });

  it('returns undefined for missing nested fields', () => {
    expect(getEvaluateValue({})).toBeUndefined();
    expect(getEvaluateValue({ result: {} })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the helper does not exist yet**

Run:

```bash
npm run test -- tests/mcp/eval.test.ts
```

Expected: FAIL with a module resolution error for `../../src/mcp/eval` or missing export.

- [ ] **Step 3: Write the minimal helper**

Create `src/mcp/eval.ts`:

```ts
export function getEvaluateValue<T = unknown>(response: any): T | undefined {
  return response?.result?.result?.value as T | undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run test -- tests/mcp/eval.test.ts
```

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit the helper**

```bash
git add src/mcp/eval.ts tests/mcp/eval.test.ts
git commit -m "test: cover cdp evaluate value parsing"
```

---

### Task 3: Repair session behavior without changing the public MCP method names

**Files:**
- Modify: `src/mcp/session.ts`
- Modify: `src/types/mcp.ts`
- Test: `tests/mcp/eval.test.ts`

- [ ] **Step 1: Extend the types so link extraction matches the real payload**

Update `src/types/mcp.ts` to:

```ts
export interface MCPRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: number | string | null;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: number | string | null;
}

export interface PageLink {
  href: string;
  text: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (
    args: Record<string, any>,
    session: any
  ) => Promise<string | Record<string, any>>;
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, any>;
    resources?: Record<string, any>;
    prompts?: Record<string, any>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}
```

- [ ] **Step 2: Refactor `src/mcp/session.ts` so only tool calls require CDP**

Apply this shape to `src/mcp/session.ts`:

```ts
import { DurableObject } from 'cloudflare:workers';
import { CDPClient } from '../cdp/client';
import { getEvaluateValue } from './eval';
import { MCPRequest, MCPResponse, MCPTool, PageLink } from '../types/mcp';
import { GotoTool, SearchTool, MarkdownTool, LinksTool } from '../tools';

const SERVER_INFO = {
  name: 'gomcp-worker',
  version: '1.0.0',
};

const PROTOCOL_VERSION = '2025-03-26';

const TOOLS: MCPTool[] = [GotoTool, SearchTool, MarkdownTool, LinksTool];

export class MCPSession extends DurableObject {
  private cdpClient: CDPClient | null = null;
  private cdpUrl = '';
  private initialized = false;
  private pageState = {
    url: null as string | null,
    title: null as string | null,
    loaded: false,
  };
  private lastAccessed = Date.now();
  private cancelledRequests: Set<string | number> = new Set();

  private readonly DEFAULTS = {
    IDLE_TIMEOUT_MS: 10 * 60 * 1000,
    COMMAND_TIMEOUT_MS: 30000,
    MAX_HTML_LENGTH: 500000,
  };

  async handleRequest(request: MCPRequest, cdpUrl: string): Promise<MCPResponse> {
    this.cdpUrl = cdpUrl;
    const now = Date.now();

    if (request.method !== 'initialize' && now - this.lastAccessed > this.DEFAULTS.IDLE_TIMEOUT_MS) {
      await this.close();
      return {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session expired due to inactivity' },
        id: request.id,
      };
    }

    this.lastAccessed = now;

    if (request.method === 'notifications/cancelled') {
      const idToCancel = request.params?.id;
      if (idToCancel !== undefined) {
        this.cancelledRequests.add(idToCancel);
      }
      return { jsonrpc: '2.0', result: null, id: null };
    }

    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      case 'tools/list':
        return this.handleToolsList(request);
      case 'ping':
        return { jsonrpc: '2.0', result: {}, id: request.id };
      case 'notifications/initialized':
        this.initialized = true;
        return { jsonrpc: '2.0', result: null, id: null };
      case 'tools/call':
        try {
          await this.ensureCDPConnection();
          return await this.handleToolCall(request);
        } catch (error: any) {
          return {
            jsonrpc: '2.0',
            error: { code: -32603, message: `CDP Connection Error: ${error.message}` },
            id: request.id,
          };
        }
      default:
        return {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${request.method}` },
          id: request.id,
        };
    }
  }

  async close(): Promise<void> {
    if (this.cdpClient) {
      this.cdpClient.close();
      this.cdpClient = null;
    }
  }

  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
      id: request.id,
    };
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      result: {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
      id: request.id,
    };
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params || {};

    if (!name) {
      return {
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Missing tool name' },
        id: request.id,
      };
    }

    if (this.cancelledRequests.has(request.id)) {
      this.cancelledRequests.delete(request.id);
      return {
        jsonrpc: '2.0',
        error: { code: -32800, message: 'Request cancelled by client' },
        id: request.id,
      };
    }

    try {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          error: { code: -32602, message: `Unknown tool: ${name}` },
          id: request.id,
        };
      }

      const result = await tool.execute(args || {}, this);
      return {
        jsonrpc: '2.0',
        result: {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        },
        id: request.id,
      };
    } catch (error: any) {
      if (this.cancelledRequests.has(request.id)) {
        this.cancelledRequests.delete(request.id);
        return {
          jsonrpc: '2.0',
          error: { code: -32800, message: 'Request cancelled' },
          id: request.id,
        };
      }

      return {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error.message || 'Internal error',
        },
        id: request.id,
      };
    }
  }

  private async ensureCDPConnection(): Promise<void> {
    if (!this.cdpUrl) {
      throw new Error('CDP URL not configured');
    }

    if (this.cdpClient && !this.cdpClient.isConnected()) {
      this.cdpClient.close();
      this.cdpClient = null;
    }

    if (!this.cdpClient) {
      this.cdpClient = new CDPClient(this.cdpUrl);
      try {
        await this.cdpClient.connectWithRetry(3);
        await this.cdpClient.send('Page.enable', {});
        await this.cdpClient.send('Runtime.enable', {});
        await this.cdpClient.send('DOM.enable', {});
      } catch (error) {
        this.cdpClient = null;
        throw new Error(`Failed to connect to CDP: ${error}`);
      }
    }
  }

  public async navigateTo(url: string): Promise<void> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    await this.cdpClient.send('Page.navigate', { url });

    const timeoutMs = this.DEFAULTS.COMMAND_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      const handler = () => {
        clearTimeout(timeout);
        this.cdpClient?.off('Page.loadEventFired', handler);
        resolve();
      };

      const timeout = setTimeout(() => {
        this.cdpClient?.off('Page.loadEventFired', handler);
        reject(new Error('Page load timeout'));
      }, timeoutMs);

      this.cdpClient.on('Page.loadEventFired', handler);
    });

    this.pageState.url = url;
    this.pageState.loaded = true;

    try {
      const result = await this.cdpClient.send('Runtime.evaluate', {
        expression: 'document.title',
      });
      this.pageState.title = getEvaluateValue<string>(result) ?? 'Unknown';
    } catch {
      this.pageState.title = 'Unknown';
    }
  }

  public async getPageContent(): Promise<string> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    const cleanedHtml = await this.cdpClient.send('Runtime.evaluate', {
      expression: `
        (function() {
          const clone = document.documentElement.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, iframe, svg, link, meta').forEach(el => el.remove());
          return clone.outerHTML;
        })()
      `,
    });

    let html = getEvaluateValue<string>(cleanedHtml) || '';

    if (html.length > this.DEFAULTS.MAX_HTML_LENGTH) {
      html = html.substring(0, this.DEFAULTS.MAX_HTML_LENGTH) + '\n\n... [Content Truncated due to length limit]';
    }

    return html;
  }

  public async getPageLinks(): Promise<PageLink[]> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    const result = await this.cdpClient.send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('a')).map(a => ({
        href: a.href,
        text: a.textContent?.trim() || ''
      }))`,
    });

    return getEvaluateValue<PageLink[]>(result) || [];
  }

  public async searchDuckDuckGo(query: string): Promise<string> {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
      await this.navigateTo(searchUrl);
    } catch (e: any) {
      return `Search navigation failed: ${e.message}`;
    }

    try {
      const results = await this.cdpClient!.send('Runtime.evaluate', {
        expression: `
          Array.from(document.querySelectorAll('.result')).map(r => {
            const titleEl = r.querySelector('.result__title a');
            const snippetEl = r.querySelector('.result__snippet');
            return {
              title: titleEl?.textContent?.trim() || '',
              url: titleEl?.href || '',
              snippet: snippetEl?.textContent?.trim() || ''
            };
          }).filter(r => r.url && r.title);
        `,
      });

      const data = getEvaluateValue<Array<{ title: string; url: string; snippet: string }>>(results) || [];
      if (data.length === 0) {
        return 'No search results found.';
      }
      return JSON.stringify(data, null, 2);
    } catch (e: any) {
      return `Failed to extract search results: ${e.message}`;
    }
  }

  public getPageState() {
    return { ...this.pageState };
  }
}
```

- [ ] **Step 3: Run type checking to catch signature mistakes immediately**

Run:

```bash
npm run typecheck
```

Expected: PASS. If it fails, correct imports and type references before continuing.

- [ ] **Step 4: Commit the session repair**

```bash
git add src/mcp/session.ts src/types/mcp.ts
git commit -m "fix: repair mcp session cdp boundaries"
```

---

### Task 4: Move SSE handshake creation into the Worker

**Files:**
- Modify: `src/index.ts`
- Test: `tests/worker/sse.test.ts`

- [ ] **Step 1: Write the failing tests for lightweight SSE handshake behavior**

Create `tests/worker/sse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSSEHandshakeResponse } from '../../src/index';

describe('createSSEHandshakeResponse', () => {
  it('returns an SSE response with a session header', async () => {
    const response = createSSEHandshakeResponse('session-123', {
      'Access-Control-Allow-Origin': '*',
    });

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Mcp-Session-Id')).toBe('session-123');
  });

  it('starts the stream with an endpoint event payload', async () => {
    const response = createSSEHandshakeResponse('session-123', {
      'Access-Control-Allow-Origin': '*',
    });

    const body = await response.text();
    expect(body).toContain('event: endpoint');
    expect(body).toContain('data: /mcp');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the helper does not exist yet**

Run:

```bash
npm run test -- tests/worker/sse.test.ts
```

Expected: FAIL with a missing export or missing file-level helper.

- [ ] **Step 3: Implement the minimal Worker-side SSE helper and route updates**

Refactor `src/index.ts` to this shape:

```ts
import { MCPSession } from './mcp/session';

export { MCPSession };

export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  CDP_URL: string;
}

const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  REQUEST_CANCELLED: -32800,
} as const;

function createErrorResponse(code: number, message: string, id: number | string | null = null, data?: any): object {
  const error: any = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', error, id };
}

export function createSSEHandshakeResponse(
  sessionId: string,
  corsHeaders: Record<string, string>,
  endpoint = '/mcp'
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`event: endpoint\nid: ${sessionId}\ndata: ${endpoint}\n\n`)
      );
      controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Mcp-Session-Id': sessionId,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === '/mcp') {
        const sessionId = request.headers.get('Mcp-Session-Id') || crypto.randomUUID();

        switch (request.method) {
          case 'GET':
            return createSSEHandshakeResponse(sessionId, corsHeaders, '/mcp');
          case 'POST':
            return await handleJSONRPC(request, env, sessionId, corsHeaders);
          case 'DELETE':
            return await handleDeleteSession(env, sessionId, corsHeaders);
          default:
            return new Response(
              JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, `Method ${request.method} not allowed`)),
              {
                status: 405,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              }
            );
        }
      }

      if (url.pathname === '/sse') {
        if (request.method === 'GET') {
          const sessionId = request.headers.get('Mcp-Session-Id') || crypto.randomUUID();
          return createSSEHandshakeResponse(sessionId, corsHeaders, '/mcp');
        }

        return new Response(
          JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Only GET method allowed for SSE endpoint')),
          {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      if (url.pathname === '/health') {
        return await handleHealthCheck(env, corsHeaders);
      }

      return new Response(
        JSON.stringify(createErrorResponse(MCPErrorCodes.METHOD_NOT_FOUND, `Not Found: ${url.pathname}`)),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify(createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, 'Internal server error', null, { message: error.message })),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};

async function handleJSONRPC(
  request: Request,
  env: Env,
  sessionId: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  let requestId: number | string | null = null;

  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return new Response(
        JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Content-Type must be application/json')),
        {
          status: 415,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    body = await request.json();
    requestId = body?.id ?? null;
  } catch (parseError: any) {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.PARSE_ERROR, `Parse error: ${parseError.message || 'Invalid JSON'}`)),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  if (body.jsonrpc !== '2.0') {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Invalid JSON-RPC version, expected "2.0"', requestId)),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  if (!body.method || typeof body.method !== 'string') {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Missing or invalid method', requestId)),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
    const response = await session.handleRequest(body, env.CDP_URL);

    return new Response(JSON.stringify(response), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
      },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, `Session error: ${error.message}`, requestId)),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
      }
    );
  }
}

async function handleDeleteSession(
  env: Env,
  sessionId: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
    await session.close();

    return new Response(JSON.stringify({ jsonrpc: '2.0', result: { closed: true }, id: null }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, `Failed to close session: ${error.message}`)),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

async function handleHealthCheck(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checks: Record<string, any> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };

  if (!env.CDP_URL) {
    checks.cdp = { status: 'not_configured', healthy: false };
    checks.status = 'degraded';
  } else {
    try {
      const cdpUrl = new URL(env.CDP_URL);
      checks.cdp = {
        status: 'configured',
        healthy: true,
        protocol: cdpUrl.protocol,
        host: cdpUrl.host,
      };
    } catch {
      checks.cdp = { status: 'invalid_url', healthy: false };
      checks.status = 'degraded';
    }
  }

  return new Response(JSON.stringify(checks), {
    status: checks.status === 'ok' ? 200 : 503,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 4: Run the Worker SSE tests**

Run:

```bash
npm run test -- tests/worker/sse.test.ts
```

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit the SSE repair**

```bash
git add src/index.ts tests/worker/sse.test.ts
git commit -m "fix: move sse handshake to worker"
```

---

### Task 5: Make deployment config and docs stop lying

**Files:**
- Modify: `wrangler.toml`
- Modify: `README.md`

- [ ] **Step 1: Add the Durable Object migration**

Update `wrangler.toml` to:

```toml
name = "gomcp-worker"
main = "src/index.ts"
compatibility_date = "2025-01-21"

[[durable_objects.bindings]]
name = "MCP_SESSION"
class_name = "MCPSession"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MCPSession"]

[vars]

[env.production]
[[env.production.durable_objects.bindings]]
name = "MCP_SESSION"
class_name = "MCPSession"
```

- [ ] **Step 2: Rewrite the README sections that currently oversell the implementation**

Replace the feature/deploy/usage parts of `README.md` with:

```md
# gomcp-worker

Cloudflare Workers 实现的 gomcp（MCP Server for Lightpanda Browser）。

## 功能特性

- ✅ 支持 MCP 协议版本 `2025-03-26`
- ✅ Streamable HTTP JSON-RPC
- ✅ 轻量 SSE 握手/兼容连接
- ✅ Durable Objects 会话管理
- ✅ CDP WebSocket 客户端（自动重连）
- ✅ HTML → Markdown 转换
- ✅ 会话空闲超时清理
- ✅ 请求取消标记支持

## 可用工具

| 工具 | 描述 | 必需参数 |
|------|------|----------|
| `goto` | 导航到指定 URL | `url` |
| `search` | 使用 DuckDuckGo 搜索 | `text` |
| `markdown` | 获取当前页面 Markdown | — |
| `links` | 提取当前页面链接 | — |

## 部署

### 1. 安装依赖

```bash
npm install
```

### 2. 配置密钥

```bash
wrangler secret set CDP_URL
```

示例值：

```text
wss://your-lightpanda-instance:9222
```

### 3. 本地开发

```bash
npm run dev
```

### 4. 部署到 Cloudflare

```bash
npm run deploy
```

> 注意：`wrangler.toml` 已包含 `MCPSession` 的 Durable Object migration。后续如重命名 Durable Object 类，必须继续追加 migration，而不是修改已有 tag。

## MCP 客户端示例

```json
{
  "mcpServers": {
    "lightpanda": {
      "url": "https://your-worker.workers.dev/mcp"
    }
  }
}
```

## 直接调用示例

```bash
curl -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'
```

## 说明

- `GET /mcp` 和 `GET /sse` 返回轻量 SSE 握手流与 `Mcp-Session-Id`，用于兼容需要建立事件流的客户端。
- 真正的工具调用走 `POST /mcp`。
- `initialize` / `tools/list` / `ping` 不依赖浏览器 CDP 连接；只有 `tools/call` 需要连接浏览器。

## 许可证

Apache-2.0
```

- [ ] **Step 3: Run the full verification set**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 4: Commit the deployment and docs repair**

```bash
git add wrangler.toml README.md
git commit -m "fix: add durable object migration and sync docs"
```

---

### Task 6: Final verification before pushing the repaired code

**Files:**
- Modify: none
- Verify: all changed files

- [ ] **Step 1: Review the commit stack and changed files**

Run:

```bash
git status
git log --oneline -5
```

Expected: clean working tree and the recent commits from Tasks 1-5 visible.

- [ ] **Step 2: Run the final verification commands once more**

Run:

```bash
npm run test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Push to `main`**

Run:

```bash
git push origin main
```

Expected: remote updated successfully.

- [ ] **Step 4: Record the outcome**

Post the resulting commit SHA and a short summary that confirms:

```text
- Durable Object migrations added
- Worker-side SSE handshake now used
- Runtime.evaluate nested value parsing fixed
- initialize/tools/list no longer require CDP
- README synced to actual behavior
```

---

## Spec Coverage Check

- Deployment repair (`wrangler.toml` migration): covered in Task 5.
- Worker-owned lightweight SSE handshake: covered in Task 4.
- Delay CDP connection until `tools/call`: covered in Task 3.
- Fix `Runtime.evaluate` parsing: covered in Tasks 2 and 3.
- Fix navigation listener cleanup: covered in Task 3.
- README sync: covered in Task 5.

## Placeholder Scan

- No `TODO` / `TBD` placeholders remain.
- All tasks include exact file paths, code, commands, and expected outcomes.

## Type Consistency Check

- `PageLink` is defined once in `src/types/mcp.ts` and used in `src/mcp/session.ts`.
- `getEvaluateValue()` is defined in `src/mcp/eval.ts` and used consistently in session logic.
- `createSSEHandshakeResponse()` is defined in `src/index.ts` and referenced consistently in the Worker SSE test.
