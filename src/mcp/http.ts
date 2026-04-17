import { MCPRequest } from '../types/mcp';

export interface SessionResolution {
  ok: boolean;
  sessionId?: string;
  errorStatus?: number;
  errorMessage?: string;
}

export function resolveSessionIdForRequest(
  request: Pick<MCPRequest, 'method'>,
  requestedSessionId: string | null,
  createSessionId: () => string = () => crypto.randomUUID()
): SessionResolution {
  if (request.method === 'initialize') {
    if (requestedSessionId) {
      return {
        ok: false,
        errorStatus: 400,
        errorMessage: 'Initialize requests must not include Mcp-Session-Id',
      };
    }

    return {
      ok: true,
      sessionId: createSessionId(),
    };
  }

  if (!requestedSessionId) {
    return {
      ok: false,
      errorStatus: 400,
      errorMessage: 'Missing Mcp-Session-Id header',
    };
  }

  return {
    ok: true,
    sessionId: requestedSessionId,
  };
}
