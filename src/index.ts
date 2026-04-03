import { MCPSession } from './mcp/session';

// 导出 Durable Object 类
export { MCPSession };

// 环境变量类型定义
export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  CDP_URL: string;
  // 补丁 2：会话空闲超时配置 (毫秒)
  SESSION_IDLE_TIMEOUT_MS?: string;
  // 补丁 1 (预留)：API Key
  API_KEY?: string;
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

    // Streamable HTTP endpoint (MCP 2025-03-26)
    if (url.pathname === '/mcp') {
      const sessionId = request.headers.get('Mcp-Session-Id');

      switch (request.method) {
        case 'GET':
          return handleSSE(request, env, sessionId, corsHeaders);
        case 'POST':
          return handleJSONRPC(request, env, sessionId, corsHeaders);
        case 'DELETE':
          return handleDeleteSession(env, sessionId, corsHeaders);
        default:
          return new Response('Method Not Allowed', {
            status: 405,
            headers: corsHeaders,
          });
      }
    }

    // 兼容旧版 SSE endpoint
    if (url.pathname === '/sse') {
      if (request.method === 'GET') {
        return handleSSE(request, env, null, corsHeaders);
      }
    }

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', {
      status: 404,
      headers: corsHeaders,
    });
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
}

// 处理 JSON-RPC 请求
async function handleJSONRPC(
  request: Request,
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  const id = sessionId || crypto.randomUUID();
  const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(id));

  // 传递 env 以支持配置读取
  const response = await session.handleRequest(body, env.CDP_URL, env);

  return new Response(JSON.stringify(response), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Mcp-Session-Id': id,
    },
  });
}

// 处理删除会话
async function handleDeleteSession(
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!sessionId) {
    return new Response('Missing Mcp-Session-Id', {
      status: 400,
      headers: corsHeaders,
    });
  }

  const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
  await session.close();

  return new Response('Session closed', {
    status: 200,
    headers: corsHeaders,
  });
}
