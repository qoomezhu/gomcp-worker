import { describe, expect, it } from 'vitest';
import { resolveSessionIdForRequest } from '../../src/mcp/http';

describe('resolveSessionIdForRequest', () => {
  it('allocates a new session id for initialize', () => {
    const result = resolveSessionIdForRequest(
      { method: 'initialize' },
      null,
      () => 'session-123'
    );

    expect(result).toEqual({
      ok: true,
      sessionId: 'session-123',
    });
  });

  it('rejects initialize requests that already include a session id header', () => {
    const result = resolveSessionIdForRequest({ method: 'initialize' }, 'session-123');

    expect(result.ok).toBe(false);
    expect(result.errorStatus).toBe(400);
    expect(result.errorMessage).toContain('must not include');
  });

  it('requires a session id for non-initialize requests', () => {
    const result = resolveSessionIdForRequest({ method: 'tools/list' }, null);

    expect(result.ok).toBe(false);
    expect(result.errorStatus).toBe(400);
    expect(result.errorMessage).toContain('Missing Mcp-Session-Id');
  });

  it('reuses the provided session id for non-initialize requests', () => {
    const result = resolveSessionIdForRequest({ method: 'tools/call' }, 'session-abc');

    expect(result).toEqual({
      ok: true,
      sessionId: 'session-abc',
    });
  });
});
