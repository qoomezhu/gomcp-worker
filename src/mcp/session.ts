import { DurableObject } from 'cloudflare:workers';
import { Env } from '../index';
import { CDPClient } from '../cdp/client';
import { MCPRequest, MCPResponse, MCPTool } from '../types/mcp';
import {
  GotoTool,
  SearchTool,
  MarkdownTool,
  LinksTool,
} from '../tools';

// MCP Server 信息
const SERVER_INFO = {
  name: 'gomcp-worker',
  version: '1.0.0',
};

// MCP 协议版本
const PROTOCOL_VERSION = '2025-03-26';

// 工具注册表
const TOOLS: MCPTool[] = [
  GotoTool,
  SearchTool,
  MarkdownTool,
  LinksTool,
];

export class MCPSession extends DurableObject {
  private sseWriter: WritableStreamDefaultWriter<string> | null = null;
  private cdpClient: CDPClient | null = null;
  private cdpUrl: string = '';
  private initialized: boolean = false;
  private pageState: {
    url: string | null;
    title: string | null;
    loaded: boolean;
  } = {
    url: null,
    title: null,
    loaded: false,
  };

  // 初始化 SSE 连接
  async initSSE(
    writer: WritableStreamDefaultWriter<string>,
    cdpUrl: string
  ): Promise<void> {
    this.sseWriter = writer;
    this.cdpUrl = cdpUrl;

    // 发送连接确认事件
    await this.sendSSE({
      event: 'endpoint',
      data: '',
      id: crypto.randomUUID(),
    });
  }

  // 处理 JSON-RPC 请求
  async handleRequest(
    request: MCPRequest,
    cdpUrl: string
  ): Promise<MCPResponse> {
    this.cdpUrl = cdpUrl;

    // 确保 CDP 连接（包含重连逻辑）
    try {
      await this.ensureCDPConnection();
    } catch (error: any) {
      return {
        jsonrpc: '2.0',
        error: { code: -32603, message: `CDP Connection Error: ${error.message}` },
        id: request.id,
      };
    }

    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      case 'tools/list':
        return this.handleToolsList(request);
      case 'tools/call':
        return this.handleToolCall(request);
      case 'ping':
        return { jsonrpc: '2.0', result: {}, id: request.id };
      case 'notifications/initialized':
        this.initialized = true;
        return { jsonrpc: '2.0', result: null, id: null };
      default:
        return {
          jsonrpc: '2.0',
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
          id: request.id,
        };
    }
  }

  // 关闭会话
  async close(): Promise<void> {
    if (this.cdpClient) {
      this.cdpClient.close();
      this.cdpClient = null;
    }
    if (this.sseWriter) {
      try {
        await this.sseWriter.close();
      } catch {
        // 忽略关闭错误
      }
      this.sseWriter = null;
    }
  }

  // 处理 initialize 请求
  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      },
      id: request.id,
    };
  }

  // 处理 tools/list 请求
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

  // 处理 tools/call 请求
  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params || {};

    if (!name) {
      return {
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Missing tool name' },
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

  // 确保 CDP 连接（带重连逻辑）
  private async ensureCDPConnection(): Promise<void> {
    if (!this.cdpUrl) {
      throw new Error('CDP URL not configured');
    }

    // 如果客户端存在但未连接，尝试重连
    if (this.cdpClient && !this.cdpClient.isConnected()) {
      console.warn('CDP connection lost, attempting to reconnect...');
      this.cdpClient.close();
      this.cdpClient = null;
    }

    if (!this.cdpClient) {
      this.cdpClient = new CDPClient(this.cdpUrl);
      try {
        // 使用带重试的连接方法
        await this.cdpClient.connectWithRetry(3);
        
        // 启用必要的域
        await this.cdpClient.send('Page.enable', {});
        await this.cdpClient.send('Runtime.enable', {});
        await this.cdpClient.send('DOM.enable', {});
      } catch (error) {
        this.cdpClient = null; // 连接失败，重置
        throw new Error(`Failed to connect to CDP: ${error}`);
      }
    }
  }

  // 发送 SSE 事件
  private async sendSSE(data: {
    event?: string;
    data: string;
    id?: string;
  }): Promise<void> {
    if (!this.sseWriter) return;

    let message = '';
    if (data.id) message += `id: ${data.id}\n`;
    if (data.event) message += `event: ${data.event}\n`;
    message += `data: ${data.data}\n\n`;

    await this.sseWriter.write(message);
  }

  // 公开方法供工具使用
  public async navigateTo(url: string): Promise<void> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    await this.cdpClient.send('Page.navigate', { url });

    // 使用 once 监听器防止泄漏
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Page load timeout'));
      }, 30000);

      // 使用 once: true 确保监听器在触发后自动移除
      this.cdpClient!.on('Page.loadEventFired', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });

    this.pageState.url = url;
    this.pageState.loaded = true;

    // 获取页面标题
    try {
      const result = await this.cdpClient.send('Runtime.evaluate', {
        expression: 'document.title',
      });
      this.pageState.title = result.result.value;
    } catch {
      this.pageState.title = 'Unknown';
    }
  }

  public async getPageContent(): Promise<string> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    const result = await this.cdpClient.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
    });

    return result.result.value || '';
  }

  public async getPageLinks(): Promise<string[]> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    const result = await this.cdpClient.send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('a')).map(a => ({
        href: a.href,
        text: a.textContent?.trim() || ''
      }))`,
    });

    return result.result.value || [];
  }

  public async searchDuckDuckGo(query: string): Promise<string> {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await this.navigateTo(searchUrl);

    const results = await this.cdpClient!.send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('.result')).map(r => ({
        title: r.querySelector('.result__title')?.textContent?.trim() || '',
        url: r.querySelector('.result__url')?.href || '',
        snippet: r.querySelector('.result__snippet')?.textContent?.trim() || ''
      }))`,
    });

    return JSON.stringify(results.result.value || [], null, 2);
  }

  public getPageState() {
    return { ...this.pageState };
  }
}
