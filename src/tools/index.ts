import { MCPTool } from '../types/mcp';

// 动态导入 Turndown（Workers 环境兼容）
let TurndownService: any;
let turndownPluginGfm: any;

async function getTurndownInstance() {
  if (!TurndownService) {
    const turndownModule = await import('turndown');
    TurndownService = turndownModule.default || turndownModule;
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
    const turndown = await getTurndownInstance();
    return turndown.turndown(html);
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
