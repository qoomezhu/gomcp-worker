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

  // 补丁 2 & 3 相关属性
  private lastAccessed: number = Date.now();
  private cancelledRequests: Set<string | number> = new Set();

  // 默认配置
  private readonly DEFAULTS = {
    IDLE_TIMEOUT_MS: 10 * 60 * 1000, // 10 分钟
    COMMAND_TIMEOUT_MS: 30000,       // 30 秒
    MAX_HTML_LENGTH: 500000,         // 500KB
  };

  // 初始化 SSE 连接
  async initSSE(
    writer: WritableStreamDefaultWriter<string>,
    cdpUrl: string
  ): Promise<void> {
    this.sseWriter = writer;
    this.cdpUrl = cdpUrl;
    this.lastAccessed = Date.now(); // 重置活跃时间

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
    cdpUrl: string,
    env?: Env
  ): Promise<MCPResponse> {
    this.cdpUrl = cdpUrl;
    const now = Date.now();

    // 获取超时配置
    const idleTimeout = env?.SESSION_IDLE_TIMEOUT_MS
      ? parseInt(env.SESSION_IDLE_TIMEOUT_MS)
      : this.DEFAULTS.IDLE_TIMEOUT_MS;

    // 【补丁 2】检查空闲超时
    if (
      request.method !== 'initialize' &&
      now - this.lastAccessed > idleTimeout
    ) {
      await this.close(); // 清理资源
      return {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session expired due to inactivity' },
        id: request.id,
      };
    }

    // 更新活跃时间
    this.lastAccessed = now;

    // 【补丁 3】处理取消通知
    if (request.method === 'notifications/cancelled') {
      const idToCancel = request.params?.id;
      if (idToCancel !== undefined) {
        this.cancelledRequests.add(idToCancel);
        console.log(`Request ${idToCancel} marked as cancelled`);
      }
      return { jsonrpc: '2.0', result: null, id: null };
    }

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

    // 【补丁 3】检查请求是否被取消
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

      // 执行工具前再次检查
      if (this.cancelledRequests.has(request.id)) {
        this.cancelledRequests.delete(request.id);
        return {
          jsonrpc: '2.0',
          error: { code: -32800, message: 'Request cancelled by client' },
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
      // 检查是否在工具执行期间被取消
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
  public async navigateTo(url: string, env?: Env): Promise<void> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    await this.cdpClient.send('Page.navigate', { url });

    // 获取超时配置
    const timeoutMs = env?.CDP_COMMAND_TIMEOUT_MS
      ? parseInt(env.CDP_COMMAND_TIMEOUT_MS)
      : this.DEFAULTS.COMMAND_TIMEOUT_MS;

    // 使用 once 监听器防止泄漏
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Page load timeout'));
      }, timeoutMs);

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

  // 优化：浏览器端清理 + 截断
  public async getPageContent(env?: Env): Promise<string> {
    if (!this.cdpClient) {
      throw new Error('CDP not connected');
    }

    // 1. 在浏览器端清理无用标签，减少传输体积
    const cleanedHtml = await this.cdpClient.send('Runtime.evaluate', {
      expression: `
        (function() {
          // 克隆 DOM 树以避免修改原页面
          const clone = document.documentElement.cloneNode(true);
          // 移除干扰元素
          clone.querySelectorAll('script, style, noscript, iframe, svg, link, meta').forEach(el => el.remove());
          return clone.outerHTML;
        })()
      `,
    });

    let html = cleanedHtml.result.value || '';

    // 2. 限制最大长度，防止 Turndown 处理超时
    const maxLength = env?.MAX_HTML_LENGTH
      ? parseInt(env.MAX_HTML_LENGTH)
      : this.DEFAULTS.MAX_HTML_LENGTH;

    if (html.length > maxLength) {
      html = html.substring(0, maxLength) + '\n\n... [Content Truncated due to length limit]';
    }

    return html;
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

  // 优化：错误处理 + 健壮的选择器
  public async searchDuckDuckGo(query: string, env?: Env): Promise<string> {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    // 1. 尝试导航
    try {
      await this.navigateTo(searchUrl, env);
    } catch (e: any) {
      return `Search navigation failed: ${e.message}`;
    }

    // 2. 更健壮的提取逻辑
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
          }).filter(r => r.url && r.title); // 过滤无效结果
        `,
      });

      const data = results.result.value || [];
      if (data.length === 0) {
        return "No search results found.";
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
