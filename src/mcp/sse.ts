export function createSSEHandshakeResponse(
  sessionId: string,
  corsHeaders: Record<string, string>,
  endpoint = '/mcp'
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`event: endpoint\nid: ${sessionId}\ndata: ${endpoint}\n\n`)
      );
      controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Mcp-Session-Id': sessionId,
    },
  });
}
