import { MCPSession } from './mcp/session';

// 导出 Durable Object 类
export { MCPSession };

// 环境变量类型定义
export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  CDP_URL: string;
  // 补丁 2：会话空闲超时配置 (毫秒)
  SESSION_IDLE_TIMEOUT_MS?: string;
  // 补丁 1：API Key 鉴权
  API_KEY?: string;
  // 动态 CORS 配置
  ALLOWED_ORIGINS?: string;
}

// 主 Worker 入口
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request, env) });
    }

    // Streamable HTTP endpoint (MCP 2025-03-26)
    if (url.pathname === '/mcp') {
      // 【补丁 1】API Key 鉴权
      if (!verifyAuth(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...getCorsHeaders(request, env), 'Content-Type': 'application/json' },
        });
      }

      const sessionId = request.headers.get('Mcp-Session-Id');

      switch (request.method) {
        case 'GET':
          return handleSSE(request, env, sessionId, getCorsHeaders(request, env));
        case 'POST':
          return handleJSONRPC(request, env, sessionId, getCorsHeaders(request, env));
        case 'DELETE':
          return handleDeleteSession(env, sessionId, getCorsHeaders(request, env));
        default:
          return new Response('Method Not Allowed', {
            status: 405,
            headers: getCorsHeaders(request, env),
          });
      }
    }

    // 兼容旧版 SSE endpoint
    if (url.pathname === '/sse') {
      if (!verifyAuth(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...getCorsHeaders(request, env), 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'GET') {
        return handleSSE(request, env, null, getCorsHeaders(request, env));
      }
    }

    // 健康检查 (无需鉴权)
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      }), {
        headers: { ...getCorsHeaders(request, env), 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', {
      status: 404,
      headers: getCorsHeaders(request, env),
    });
  },
};

// 【补丁 1】API Key 鉴权
function verifyAuth(request: Request, env: Env): boolean {
  // 如果未设置 API_KEY，则跳过鉴权（开发环境）
  if (!env.API_KEY) return true;

  const apiKey = request.headers.get('X-Api-Key');
  return apiKey === env.API_KEY;
}

// 【补丁 1】动态 CORS 配置
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowedOrigins = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const isAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin || '');

  return {
    'Access-Control-Allow-Origin': isAllowed ? (origin || '*') : '',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, X-Api-Key',
  };
}

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
