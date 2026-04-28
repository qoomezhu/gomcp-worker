import { DurableObject } from 'cloudflare:workers';
import { CDPClient } from '../cdp/client';
import { getEvaluateValue } from './eval';
import {
  MCPRequest,
  MCPRequestId,
  MCPResponse,
  MCPTool,
  MCPToolCallResult,
  PageLink,
} from '../types/mcp';
import { GotoTool, SearchTool, MarkdownTool, LinksTool } from '../tools';

const SERVER_INFO = {
  name: 'gomcp-worker',
  version: '1.0.0',
};

const PROTOCOL_VERSION = '2025-03-26';
const SESSION_STATE_KEY = 'session_state';

// O(1) lookup map for tool resolution
const TOOLS: MCPTool[] = [GotoTool, SearchTool, MarkdownTool, LinksTool];
const TOOLS_BY_NAME = new Map<string, MCPTool>(TOOLS.map(t => [t.name, t]));
const EMPTY_RESOURCES = { resources: [] } as const;
const EMPTY_PROMPTS = { prompts: [] } as const;

// Reusable CDP Runtime.evaluate expressions — avoids reconstructing strings on every call
const HTML_CLEANUP_EXPRESSION = `
  (function () {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, svg, link, meta').forEach((el) => el.remove());
    return clone.outerHTML;
  })()
`;

type SessionStatus = 'uninitialized' | 'active' | 'closed';

interface PersistedSessionState {
  status: SessionStatus;
  initialized: boolean;
  lastAccessed: number;
}

export class MCPSession extends DurableObject {
  private cdpClient: CDPClient | null = null;
  private cdpUrl = '';
  private cdpSessionId: string | null = null;
  private cdpTargetId: string | null = null;
  private initialized = false;
  private sessionStatus: SessionStatus = 'uninitialized';
  private persistedStateLoaded = false;
  private pageState = this.createEmptyPageState();
  private lastAccessed = Date.now();
  private cancelledRequests: Set<string | number> = new Set();

  private readonly DEFAULTS = {
    IDLE_TIMEOUT_MS: 10 * 60 * 1000,
    COMMAND_TIMEOUT_MS: 30000,
    MAX_HTML_LENGTH: 500000,
  };

  async handleRequest(request: MCPRequest, cdpUrl: string): Promise<MCPResponse> {
    await this.loadPersistedState();
    this.cdpUrl = cdpUrl;

    if (request.method === 'initialize') {
      return await this.handleInitialize(request);
    }

    if (this.sessionStatus !== 'active') {
      return {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session is not active' },
        id: request.id,
      };
    }

    const now = Date.now();
    if (now - this.lastAccessed > this.DEFAULTS.IDLE_TIMEOUT_MS) {
      await this.close();
      return {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session expired due to inactivity' },
        id: request.id,
      };
    }

    this.lastAccessed = now;
    await this.persistSessionState();

    if (request.method === 'notifications/cancelled') {
      const idToCancel = request.params?.requestId;
      if (typeof idToCancel === 'string' || typeof idToCancel === 'number') {
        this.cancelledRequests.add(idToCancel);
      }
      return { jsonrpc: '2.0', result: null, id: null };
    }

    switch (request.method) {
      case 'tools/list':
        return this.handleToolsList(request);
      case 'resources/list':
        return { jsonrpc: '2.0', result: EMPTY_RESOURCES, id: request.id };
      case 'prompts/list':
        return { jsonrpc: '2.0', result: EMPTY_PROMPTS, id: request.id };
      case 'ping':
        return { jsonrpc: '2.0', result: {}, id: request.id };
      case 'notifications/initialized':
        this.initialized = true;
        await this.persistSessionState();
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

  public async getStatus(): Promise<SessionStatus> {
    await this.loadPersistedState();

    if (this.sessionStatus === 'active' && Date.now() - this.lastAccessed > this.DEFAULTS.IDLE_TIMEOUT_MS) {
      await this.close();
    }

    return this.sessionStatus;
  }

  async close(): Promise<void> {
    await this.loadPersistedState();
    this.resetBrowserState();
    this.cancelledRequests.clear();
    this.initialized = false;
    this.sessionStatus = 'closed';
    this.lastAccessed = Date.now();
    await this.persistSessionState();
  }

  private async handleInitialize(request: MCPRequest): Promise<MCPResponse> {
    this.resetBrowserState();
    this.cancelledRequests.clear();
    this.initialized = false;
    this.sessionStatus = 'active';
    this.lastAccessed = Date.now();
    await this.persistSessionState();

    return {
      jsonrpc: '2.0',
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
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

    if (this.consumeCancellation(request.id)) {
      return {
        jsonrpc: '2.0',
        error: { code: -32800, message: 'Request cancelled by client' },
        id: request.id,
      };
    }

    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) {
      return {
        jsonrpc: '2.0',
        error: { code: -32602, message: `Unknown tool: ${name}` },
        id: request.id,
      };
    }

    try {
      const result = await tool.execute(args || {}, this);
      const toolResult: MCPToolCallResult = {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      };

      return {
        jsonrpc: '2.0',
        result: toolResult,
        id: request.id,
      };
    } catch (error: any) {
      if (this.consumeCancellation(request.id)) {
        return {
          jsonrpc: '2.0',
          error: { code: -32800, message: 'Request cancelled' },
          id: request.id,
        };
      }

      const toolResult: MCPToolCallResult = {
        content: [
          {
            type: 'text',
            text: error?.message || 'Internal error',
          },
        ],
        isError: true,
      };

      return {
        jsonrpc: '2.0',
        result: toolResult,
        id: request.id,
      };
    }
  }

  private async ensureCDPConnection(): Promise<void> {
    if (!this.cdpUrl) {
      throw new Error('CDP URL not configured');
    }

    if (this.cdpClient && (!this.cdpClient.isConnected() || !this.cdpSessionId)) {
      this.resetBrowserState();
    }

    if (!this.cdpClient) {
      const client = new CDPClient(this.cdpUrl);
      await client.connectWithRetry(3);

      const { targetId, sessionId } = await client.attachToNewTarget();
      await client.send('Page.enable', {}, sessionId);
      await client.send('Runtime.enable', {}, sessionId);
      await client.send('DOM.enable', {}, sessionId);

      this.cdpClient = client;
      this.cdpTargetId = targetId;
      this.cdpSessionId = sessionId;
      this.pageState = this.createEmptyPageState();
    }
  }

  public async navigateTo(url: string): Promise<void> {
    if (!this.cdpClient || !this.cdpSessionId) {
      throw new Error('CDP not connected');
    }

    const waitForLoad = this.cdpClient.waitForAnyEvent(['Page.loadEventFired'], {
      sessionId: this.cdpSessionId,
      timeoutMs: this.DEFAULTS.COMMAND_TIMEOUT_MS,
    });

    this.pageState = {
      url,
      title: null,
      loaded: false,
    };

    await this.cdpClient.send('Page.navigate', { url }, this.cdpSessionId);
    await waitForLoad;

    const result = await this.cdpClient.send<any>(
      'Runtime.evaluate',
      {
        expression: 'document.title',
        returnByValue: true,
      },
      this.cdpSessionId
    );

    this.pageState = {
      url,
      title: getEvaluateValue<string>(result) ?? 'Unknown',
      loaded: true,
    };
  }

  public async getPageContent(): Promise<string> {
    this.assertPageLoaded();

    if (!this.cdpClient || !this.cdpSessionId) {
      throw new Error('CDP not connected');
    }

    const cleanedHtml = await this.cdpClient.send<any>(
      'Runtime.evaluate',
      {
        expression: HTML_CLEANUP_EXPRESSION,
        returnByValue: true,
      },
      this.cdpSessionId
    );

    let html = getEvaluateValue<string>(cleanedHtml) || '';
    if (html.length > this.DEFAULTS.MAX_HTML_LENGTH) {
      html = html.substring(0, this.DEFAULTS.MAX_HTML_LENGTH) + '\n\n... [Content truncated due to length limit]';
    }

    return html;
  }

  public async getPageLinks(): Promise<PageLink[]> {
    this.assertPageLoaded();

    if (!this.cdpClient || !this.cdpSessionId) {
      throw new Error('CDP not connected');
    }

    const result = await this.cdpClient.send<any>(
      'Runtime.evaluate',
      {
        expression: `
          Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
            href: anchor.href,
            text: anchor.textContent?.trim() || ''
          }))
        `,
        returnByValue: true,
      },
      this.cdpSessionId
    );

    return getEvaluateValue<PageLink[]>(result) || [];
  }

  public async searchDuckDuckGo(query: string): Promise<string> {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    await this.navigateTo(searchUrl);

    if (!this.cdpClient || !this.cdpSessionId) {
      throw new Error('CDP not connected');
    }

    const results = await this.cdpClient.send<any>(
      'Runtime.evaluate',
      {
        expression: `
          Array.from(document.querySelectorAll('.result')).map((result) => {
            const titleEl = result.querySelector('.result__title a');
            const snippetEl = result.querySelector('.result__snippet');
            return {
              title: titleEl?.textContent?.trim() || '',
              url: titleEl?.href || '',
              snippet: snippetEl?.textContent?.trim() || ''
            };
          }).filter((entry) => entry.url && entry.title)
        `,
        returnByValue: true,
      },
      this.cdpSessionId
    );

    const data = getEvaluateValue<Array<{ title: string; url: string; snippet: string }>>(results) || [];
    if (data.length === 0) {
      return 'No search results found.';
    }

    return JSON.stringify(data);
  }

  public getPageState() {
    return { ...this.pageState };
  }

  private createEmptyPageState() {
    return {
      url: null as string | null,
      title: null as string | null,
      loaded: false,
    };
  }

  private resetBrowserState(): void {
    if (this.cdpClient) {
      this.cdpClient.close();
    }

    this.cdpClient = null;
    this.cdpSessionId = null;
    this.cdpTargetId = null;
    this.pageState = this.createEmptyPageState();
  }

  private async loadPersistedState(): Promise<void> {
    if (this.persistedStateLoaded) {
      return;
    }

    const storedState = await this.ctx.storage.get<PersistedSessionState>(SESSION_STATE_KEY);
    if (storedState) {
      this.sessionStatus = storedState.status;
      this.initialized = storedState.initialized;
      this.lastAccessed = storedState.lastAccessed;
    }

    this.persistedStateLoaded = true;
  }

  private async persistSessionState(): Promise<void> {
    const persistedState: PersistedSessionState = {
      status: this.sessionStatus,
      initialized: this.initialized,
      lastAccessed: this.lastAccessed,
    };

    await this.ctx.storage.put(SESSION_STATE_KEY, persistedState);
  }

  private assertPageLoaded(): void {
    if (!this.pageState.loaded) {
      throw new Error('No page loaded. Use goto or search first.');
    }
  }

  private consumeCancellation(requestId: MCPRequestId): boolean {
    if (requestId === null) {
      return false;
    }

    if (!this.cancelledRequests.has(requestId)) {
      return false;
    }

    this.cancelledRequests.delete(requestId);
    return true;
  }
}
