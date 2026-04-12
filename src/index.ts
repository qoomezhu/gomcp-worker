import { MCPSession } from './mcp/session';
import { createSSEHandshakeResponse } from './mcp/sse';

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === '/mcp') {
        const requestedSessionId = request.headers.get('Mcp-Session-Id');

        switch (request.method) {
          case 'GET': {
            const sessionId = requestedSessionId || crypto.randomUUID();
            return createSSEHandshakeResponse(sessionId, corsHeaders, '/mcp');
          }
          case 'POST': {
            const sessionId = requestedSessionId || crypto.randomUUID();
            return await handleJSONRPC(request, env, sessionId, corsHeaders);
          }
          case 'DELETE':
            return await handleDeleteSession(env, requestedSessionId, corsHeaders);
          default:
            return new Response(
              JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, `Method ${request.method} not allowed`)),
              {
                status: 405,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              }
            );
        }
      }

      if (url.pathname === '/sse') {
        if (request.method === 'GET') {
          const sessionId = request.headers.get('Mcp-Session-Id') || crypto.randomUUID();
          return createSSEHandshakeResponse(sessionId, corsHeaders, '/mcp');
        }

        return new Response(
          JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Only GET method allowed for SSE endpoint')),
          {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      if (url.pathname === '/health') {
        return await handleHealthCheck(env, corsHeaders);
      }

      return new Response(
        JSON.stringify(createErrorResponse(MCPErrorCodes.METHOD_NOT_FOUND, `Not Found: ${url.pathname}`)),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    } catch (error: any) {
      console.error('Worker unhandled error:', error);
      return new Response(
        JSON.stringify(createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, 'Internal server error', null, { message: error.message })),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};

async function handleJSONRPC(
  request: Request,
  env: Env,
  sessionId: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  let requestId: number | string | null = null;

  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return new Response(
        JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Content-Type must be application/json')),
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
      JSON.stringify(createErrorResponse(MCPErrorCodes.PARSE_ERROR, `Parse error: ${parseError.message || 'Invalid JSON'}`)),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  if (body.jsonrpc !== '2.0') {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Invalid JSON-RPC version, expected "2.0"', requestId)),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  if (!body.method || typeof body.method !== 'string') {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_REQUEST, 'Missing or invalid method', requestId)),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
    const response = await session.handleRequest(body, env.CDP_URL || '');

    return new Response(JSON.stringify(response), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
      },
    });
  } catch (error: any) {
    console.error('Session request error:', error);
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, `Session error: ${error.message}`, requestId)),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
      }
    );
  }
}

async function handleDeleteSession(
  env: Env,
  sessionId: string | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!sessionId) {
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INVALID_PARAMS, 'Missing Mcp-Session-Id header')),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const session = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
    await session.close();

    return new Response(JSON.stringify({ jsonrpc: '2.0', result: { closed: true }, id: null }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Session close error:', error);
    return new Response(
      JSON.stringify(createErrorResponse(MCPErrorCodes.INTERNAL_ERROR, `Failed to close session: ${error.message}`)),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
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

  return new Response(JSON.stringify(checks), {
    status: checks.status === 'ok' ? 200 : 503,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
