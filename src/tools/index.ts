import { MCPTool } from '../types/mcp';

// 动态导入 Turndown（Workers 环境兼容）
let TurndownService: any;
let turndownLoadError: Error | null = null;

/**
 * 获取 Turndown 实例，带错误处理和重试机制
 * @param retryCount - 重试次数
 * @returns TurndownService 实例
 * @throws 当加载失败时抛出错误
 */
async function getTurndownInstance(retryCount = 2): Promise<any> {
  // 如果之前加载失败且未超过重试次数，直接抛出错误
  if (turndownLoadError && retryCount <= 0) {
    throw new Error(`Turndown 加载失败: ${turndownLoadError.message}`);
  }

  if (!TurndownService) {
    try {
      const turndownModule = await import('turndown');
      TurndownService = turndownModule.default || turndownModule;
      turndownLoadError = null; // 清除之前的错误
    } catch (error: any) {
      turndownLoadError = error;
      console.error('Turndown 加载失败:', error);
      
      if (retryCount > 0) {
        console.log(`Turndown 加载重试，剩余次数: ${retryCount - 1}`);
        // 短暂延迟后重试
        await new Promise(resolve => setTimeout(resolve, 100));
        return getTurndownInstance(retryCount - 1);
      }
      
      throw new Error(`无法加载 Turndown 库: ${error.message || '未知错误'}`);
    }
  }
  
  return new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
}

// goto 工具 - 导航到指定 URL
export const GotoTool: MCPTool = {
  name: 'goto',
  description: 'Navigate to a URL and load the page in the browser',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to navigate to',
      },
    },
    required: ['url'],
  },
  execute: async (args, session) => {
    const url = args.url;
    if (!url) {
      throw new Error('Missing required parameter: url');
    }

    // 验证 URL 格式
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid URL format: ${url}`);
    }

    await session.navigateTo(url);
    const state = session.getPageState();

    return `Navigated to ${url}\nTitle: ${state.title || 'Unknown'}`;
  },
};

// search 工具 - 通过 DuckDuckGo 搜索
export const SearchTool: MCPTool = {
  name: 'search',
  description: 'Search the web using DuckDuckGo',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['text'],
  },
  execute: async (args, session) => {
    const query = args.text;
    if (!query) {
      throw new Error('Missing required parameter: text');
    }

    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('Search query must be a non-empty string');
    }

    return await session.searchDuckDuckGo(query);
  },
};

// markdown 工具 - 获取页面内容的 Markdown 格式
export const MarkdownTool: MCPTool = {
  name: 'markdown',
  description: 'Get the current page content as Markdown',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (args, session) => {
    const html = await session.getPageContent();
    
    // 处理 Turndown 加载失败的情况
    try {
      const turndown = await getTurndownInstance();
      return turndown.turndown(html);
    } catch (error: any) {
      console.error('Markdown conversion failed:', error);
      
      // 降级方案：返回原始 HTML 并附加说明
      const errorMessage = error.message || 'Unknown error';
      return `[Markdown conversion unavailable: ${errorMessage}]\n\n---\n\nOriginal HTML:\n\n${html.substring(0, 50000)}${html.length > 50000 ? '\n\n... [truncated]' : ''}`;
    }
  },
};

// links 工具 - 提取页面所有链接
export const LinksTool: MCPTool = {
  name: 'links',
  description: 'Extract all links from the current page',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (args, session) => {
    const links = await session.getPageLinks();
    
    // 验证返回数据
    if (!Array.isArray(links)) {
      throw new Error('Invalid response from getPageLinks: expected array');
    }
    
    return JSON.stringify(links, null, 2);
  },
};
