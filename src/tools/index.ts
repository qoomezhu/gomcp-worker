import { convertHtmlToMarkdown } from './markdown';
import { MCPTool } from '../types/mcp';

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

export const MarkdownTool: MCPTool = {
  name: 'markdown',
  description: 'Get the current page content as Markdown',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (_args, session) => {
    const html = await session.getPageContent();
    return await convertHtmlToMarkdown(html);
  },
};

export const LinksTool: MCPTool = {
  name: 'links',
  description: 'Extract all links from the current page',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (_args, session) => {
    const links = await session.getPageLinks();

    if (!Array.isArray(links)) {
      throw new Error('Invalid response from getPageLinks: expected array');
    }

    return JSON.stringify(links, null, 2);
  },
};
