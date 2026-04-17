export type MCPRequestId = number | string | null;

export interface MCPRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: MCPRequestId;
}

export interface MCPToolCallContent {
  type: 'text';
  text: string;
}

export interface MCPToolCallResult {
  content: MCPToolCallContent[];
  isError?: boolean;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: MCPRequestId;
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
