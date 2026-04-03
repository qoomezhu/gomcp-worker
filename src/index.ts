import { MCPSession } from './mcp/session';

// 导出 Durable Object 类
export { MCPSession };

// 环境变量类型定义
export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  CDP_URL: string;
}

// MCP JSON-RPC 错误码
const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  REQUEST_CANCELLED: -32800,
} as const;

// 创建 MCP 错误响应
function createErrorResponse(code: number, message: string, id: number | string | null = null, data?: any): object {
  const error: any = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', error, id };
}

// 主 Worker 入口
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
    };

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Streamable HTTP endpoint (MCP 2025-03-26)
      if (url.pathname === '/mcp') {
        const sessionId = request.headers.get('Mcp-Session-Id');

        switch (request.method) {
          case 'GET':
            return await handleSSE(request, env, sessionId, corsHeaders);
          case 'POST':
            return await handleJSONRPC(request, env, sessionId, corsHeaders);
          case 'DELETE':
            return await handleDeleteSession(env, sessionId, corsHeaders);
          default:
            return new Response(
              JSON.stringify(createErrorResponse(
                MCPErrorCodes.INVALID_REQUEST,
                `Method ${request.method} not allowed`
              )),
              {
                status: 405,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              }
            );
        }
      }

      // 兼容旧版 SSE endpoint
      if (url.pathname === '/sse') {
        if (request.method === 'GET') {
          return await handleSSE(request, env, null, corsHeaders);
        }
        return new Response(
          JSON.stringify(createErrorResponse(
            MCPErrorCodes.INVALID_REQUEST,
            'Only GET method allowed for SSE endpoint'
          )),
          {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // 健康检查
      if (url.pathname === '/health') {
        return await handleHealthCheck(env, corsHeaders);
      }

      return new Response(
        JSON.stringify(createErrorResponse(
          MCPErrorCodes.METHOD_NOT_FOUND,
          `Not Found: ${url.pathname}`
        )),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    } catch (error: any) {
      // 全局错误处理
      console.error('Worker unhandled error:', error);
      return new Response(
        JSON.stringify(createErrorResponse(
          MCPErrorCodes.INTERNAL_ERROR,
          'Internal server error',
          null,
          { message: error.message }
        )),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};

// 处理 SSE 连接
async function handleSSE(
  request: Request,
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const id = sessionId || crypto.randomUUID();
  
  try {
    const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(id));
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // 初始化 SSE 会话
    await session.initSSE(writer, env.CDP_URL);

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Mcp-Session-Id': id,
      },
    });
  } catch (error: any) {
    console.error('SSE initialization error:', error);
    return new Response(
      JSON.stringify(createErrorResponse(
        MCPErrorCodes.SERVER_ERROR,
        'Failed to initialize SSE session',
        null,
        { message: error.message }
      )),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

// 处理 JSON-RPC 请求
async function handleJSONRPC(
  request: Request,
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  let requestId: number | string | null = null;

  // 1. 解析请求体
  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return new Response(
        JSON.stringify(createErrorResponse(
          MCPErrorCodes.INVALID_REQUEST,
          'Content-Type must be application/json'
        )),
        {
          status: 415,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    body = await request.json();
    requestId = body?.id ?? null;
  } catch (parseError: any) {
    console.error('JSON parse error:', parseError);
    return new Response(
      JSON.stringify(createErrorResponse(
        MCPErrorCodes.PARSE_ERROR,
        `Parse error: ${parseError.message || 'Invalid JSON'}`
      )),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  // 2. 验证 JSON-RPC 请求格式
  if (body.jsonrpc !== '2.0') {
    return new Response(
      JSON.stringify(createErrorResponse(
        MCPErrorCodes.INVALID_REQUEST,
        'Invalid JSON-RPC version, expected "2.0"',
        requestId
      )),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  if (!body.method || typeof body.method !== 'string') {
    return new Response(
      JSON.stringify(createErrorResponse(
        MCPErrorCodes.INVALID_REQUEST,
        'Missing or invalid method',
        requestId
      )),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  // 3. 处理请求
  const id = sessionId || crypto.randomUUID();
  
  try {
    const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(id));
    const response = await session.handleRequest(body, env.CDP_URL);

    return new Response(JSON.stringify(response), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Mcp-Session-Id': id,
      },
    });
  } catch (error: any) {
    console.error('Session request error:', error);
    return new Response(
      JSON.stringify(createErrorResponse(
        MCPErrorCodes.INTERNAL_ERROR,
        `Session error: ${error.message}`,
        requestId
      )),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Mcp-Session-Id': id },
      }
    );
  }
}

// 处理删除会话
async function handleDeleteSession(
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!sessionId) {
    return new Response(
      JSON.stringify(createErrorResponse(
        MCPErrorCodes.INVALID_PARAMS,
        'Missing Mcp-Session-Id header'
      )),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
    await session.close();

    return new Response(
      JSON.stringify({ jsonrpc: '2.0', result: { closed: true }, id: null }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Session close error:', error);
    return new Response(
      JSON.stringify(createErrorResponse(
        MCPErrorCodes.INTERNAL_ERROR,
        `Failed to close session: ${error.message}`
      )),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

// 健康检查
async function handleHealthCheck(
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const checks: Record<string, any> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };

  // 检查 CDP_URL 配置
  if (!env.CDP_URL) {
    checks.cdp = { status: 'not_configured', healthy: false };
    checks.status = 'degraded';
  } else {
    try {
      // 验证 CDP URL 格式
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

  const statusCode = checks.status === 'ok' ? 200 : 503;
  
  return new Response(JSON.stringify(checks), {
    status: statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
