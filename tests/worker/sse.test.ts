import { describe, expect, it } from 'vitest';
import { createSSEHandshakeResponse } from '../../src/mcp/sse';

describe('createSSEHandshakeResponse', () => {
  it('returns an SSE response with a session header', async () => {
    const response = createSSEHandshakeResponse('session-123', {
      'Access-Control-Allow-Origin': '*',
    });

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Mcp-Session-Id')).toBe('session-123');
  });

  it('starts the stream with an endpoint event payload', async () => {
    const response = createSSEHandshakeResponse('session-123', {
      'Access-Control-Allow-Origin': '*',
    });

    const body = await response.text();
    expect(body).toContain('event: endpoint');
    expect(body).toContain('data: /mcp');
  });
});
