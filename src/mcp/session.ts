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
