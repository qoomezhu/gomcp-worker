import { MCPTool } from '../types/mcp';

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

    // 简化版 HTML 转 Markdown
    // 实际项目中可以使用 turndown 等库
    return htmlToMarkdown(html);
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
    return JSON.stringify(links, null, 2);
  },
};

// 简易 HTML 转 Markdown 函数
function htmlToMarkdown(html: string): string {
  // 移除 script 和 style 标签
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 限制输出长度
  if (text.length > 10000) {
    text = text.substring(0, 10000) + '\n...[truncated]';
  }

  return text;
}
