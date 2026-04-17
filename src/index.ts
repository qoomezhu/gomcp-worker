import { MCPSession } from './mcp/session';
import { createSSEHandshakeResponse } from './mcp/sse';
import { resolveSessionIdForRequest } from './mcp/http';

export { MCPSession, createSSEHandshakeResponse };

export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  CDP_URL?: string;
}

const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  REQUEST_CANCELLED: -32800,
} as const;

function createErrorResponse(code: number, message: string, id: number | string | null = null, data?: any): object {
  const error: any = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', error, id };
}

function createCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}

function createJSONResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      'Content-Type': 'application/json',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = createCorsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === '/mcp') {
        switch (request.method) {
          case 'GET':
            return await handleSSERequest(env, request.headers.get('Mcp-Session-Id'), corsHeaders, '/mcp');
          case 'POST':
            return await handleJSONRPC(request, env, corsHeaders);
          case 'DELETE':
            return await handleDeleteSession(env, request.headers.get('Mcp-Session-Id'), corsHeaders);
          default:
            return createJSONResponse(
              createErrorResponse(MCPErrorCodes.INVALID_REQUEST, `Method ${request.method} not allowed`),
              405,
              corsHeaders
            );
        }
      }

      if (url.pathname === '/sse') {
        if (request.method === 'GET') {
          return await handleSSERequest(env, request.headers.get('Mcp-Session-Id'), corsHeaders, '/mcp');
        }

        return createJSONResponse(
          createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Only GET method allowed for SSE endpoint'),
          405,
          corsHeaders
        );
      }

      if (url.pathname === '/health') {
        return await handleHealthCheck(env, corsHeaders);
      }

      return createJSONResponse(
        createErrorResponse(MCPErrorCodes.METHOD_NOT_FOUND, `Not Found: ${url.pathname}`),
        404,
        corsHeaders
      );
    } catch (error: any) {
      console.error('Worker unhandled error:', error);
      return createJSONResponse(
        createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, 'Internal server error', null, { message: error.message }),
        500,
        corsHeaders
      );
    }
  },
};

async function handleSSERequest(
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>,
  endpoint: string
): Promise<Response> {
  if (!sessionId) {
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INVALID_PARAMS, 'Missing Mcp-Session-Id header'),
      400,
      corsHeaders
    );
  }

  const status = await getSessionStatus(env, sessionId);
  if (status !== 'active') {
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INVALID_PARAMS, `Unknown or expired session: ${sessionId}`),
      404,
      corsHeaders
    );
  }

  return createSSEHandshakeResponse(sessionId, corsHeaders, endpoint);
}

async function handleJSONRPC(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  let requestId: number | string | null = null;

  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return createJSONResponse(
        createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Content-Type must be application/json'),
        415,
        corsHeaders
      );
    }

    body = await request.json();
    requestId = body?.id ?? null;
  } catch (parseError: any) {
    console.error('JSON parse error:', parseError);
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.PARSE_ERROR, `Parse error: ${parseError.message || 'Invalid JSON'}`),
      400,
      corsHeaders
    );
  }

  if (body?.jsonrpc !== '2.0') {
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Invalid JSON-RPC version, expected "2.0"', requestId),
      400,
      corsHeaders
    );
  }

  if (!body?.method || typeof body.method !== 'string') {
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Missing or invalid method', requestId),
      400,
      corsHeaders
    );
  }

  const resolution = resolveSessionIdForRequest(
    { method: body.method },
    request.headers.get('Mcp-Session-Id')
  );

  if (!resolution.ok || !resolution.sessionId) {
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INVALID_PARAMS, resolution.errorMessage || 'Invalid session request', requestId),
      resolution.errorStatus || 400,
      corsHeaders
    );
  }

  const sessionId = resolution.sessionId;
  const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));

  if (body.method !== 'initialize') {
    const status = await session.getStatus();
    if (status !== 'active') {
      return createJSONResponse(
        createErrorResponse(MCPErrorCodes.INVALID_PARAMS, `Unknown or expired session: ${sessionId}`, requestId),
        404,
        corsHeaders
      );
    }
  }

  try {
    const response = await session.handleRequest(body, env.CDP_URL || '');
    return createJSONResponse(response, 200, corsHeaders, { 'Mcp-Session-Id': sessionId });
  } catch (error: any) {
    console.error('Session request error:', error);
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, `Session error: ${error.message}`, requestId),
      500,
      corsHeaders,
      { 'Mcp-Session-Id': sessionId }
    );
  }
}

async function handleDeleteSession(
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!sessionId) {
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INVALID_PARAMS, 'Missing Mcp-Session-Id header'),
      400,
      corsHeaders
    );
  }

  const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
  const status = await session.getStatus();
  if (status !== 'active') {
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INVALID_PARAMS, `Unknown or expired session: ${sessionId}`),
      404,
      corsHeaders
    );
  }

  try {
    await session.close();
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Mcp-Session-Id': sessionId,
      },
    });
  } catch (error: any) {
    console.error('Session close error:', error);
    return createJSONResponse(
      createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, `Failed to close session: ${error.message}`),
      500,
      corsHeaders
    );
  }
}

async function getSessionStatus(env: Env, sessionId: string): Promise<'active' | 'uninitialized' | 'closed'> {
  const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
  return await session.getStatus();
}

async function handleHealthCheck(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checks: Record<string, any> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };

  if (!env.CDP_URL) {
    checks.cdp = { status: 'not_configured', healthy: false };
    checks.status = 'degraded';
  } else {
    try {
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

  return createJSONResponse(checks, checks.status === 'ok' ? 200 : 503, corsHeaders);
}
