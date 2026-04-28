type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type CDPEventListener = {
  callback: (params: any, message: any) => void;
  once: boolean;
  sessionId?: string;
};

export interface AttachedTarget {
  targetId: string;
  sessionId: string;
}

export class CDPClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly pendingRequests: Map<number, PendingRequest> = new Map();
  private readonly eventListeners: Map<string, CDPEventListener[]> = new Map();
  private connected = false;
  private nextRequestId = 0;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws) {
      return;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      let settled = false;

      const cleanupAll = () => {
        if (settled) return;
        settled = true;
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('message', onMessage);
      };

      const onOpen = () => {
        this.connected = true;
        cleanupAll();
        resolve();
      };

      const onClose = () => {
        this.connected = false;
        this.failPendingRequests(new Error('WebSocket closed'));
      };

      const onError = (event: Event) => {
        cleanupAll();
        reject(new Error(`WebSocket error: ${String(event)}`));
      };

      const onMessage = (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : '';
        this.handleMessage(data);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
      ws.addEventListener('message', onMessage);
    });
  }

  async connectWithRetry(maxRetries = 3): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.connect();
        return;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`CDP connection attempt ${attempt + 1} failed: ${lastError.message}`);

        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError ?? new Error('CDP connection failed after retries');
  }

  async attachToNewTarget(): Promise<AttachedTarget> {
    const targetResponse = await this.send<any>('Target.createTarget', { url: 'about:blank' });
    const targetId = targetResponse?.result?.targetId;

    if (!targetId) {
      throw new Error('Target.createTarget did not return a targetId');
    }

    const attachResponse = await this.send<any>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = attachResponse?.result?.sessionId;

    if (!sessionId) {
      throw new Error('Target.attachToTarget did not return a sessionId');
    }

    return { targetId, sessionId };
  }

  async waitForAnyEvent(
    methods: string[],
    options: { sessionId?: string; timeoutMs?: number } = {}
  ): Promise<{ method: string; params: any; message: any }> {
    if (methods.length === 0) {
      throw new Error('At least one CDP event must be provided');
    }

    const timeoutMs = options.timeoutMs ?? 30000;

    return new Promise((resolve, reject) => {
      const listeners: Array<{
        method: string;
        callback: (params: any, message: any) => void;
      }> = [];

      const cleanup = () => {
        clearTimeout(timeout);
        for (const listener of listeners) {
          this.off(listener.method, listener.callback);
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`CDP event timeout: ${methods.join(', ')}`));
      }, timeoutMs);

      for (const method of methods) {
        const callback = (params: any, message: any) => {
          cleanup();
          resolve({ method, params, message });
        };

        listeners.push({ method, callback });
        this.on(method, callback, { once: true, sessionId: options.sessionId });
      }
    });
  }

  async send<T = any>(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<T> {
    const currentWs = this.ws;
    if (!currentWs || !this.connected) {
      throw new Error('CDP not connected');
    }

    const id = ++this.nextRequestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const payload: Record<string, any> = {
        id,
        method,
        params,
      };

      if (sessionId) {
        payload.sessionId = sessionId;
      }

      currentWs.send(JSON.stringify(payload));
    });
  }

  on(
    event: string,
    callback: (params: any, message: any) => void,
    options?: { once?: boolean; sessionId?: string }
  ): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }

    this.eventListeners.get(event)!.push({
      callback,
      once: options?.once ?? false,
      sessionId: options?.sessionId,
    });
  }

  off(event: string, callback: (params: any, message: any) => void): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) {
      return;
    }

    const index = listeners.findIndex((listener) => listener.callback === callback);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.failPendingRequests(new Error('WebSocket closed'));
    this.eventListeners.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      if (typeof message?.id === 'number' && this.pendingRequests.has(message.id)) {
        const pending = this.pendingRequests.get(message.id)!;
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timeout);

        if (message.error) {
          pending.reject(new Error(message.error.message || 'CDP error'));
        } else {
          pending.resolve(message);
        }
        return;
      }

      if (typeof message?.method === 'string') {
        const listeners = this.eventListeners.get(message.method) ?? [];
        const remaining: CDPEventListener[] = [];

        for (const listener of listeners) {
          if (listener.sessionId && listener.sessionId !== message.sessionId) {
            remaining.push(listener);
            continue;
          }

          listener.callback(message.params, message);
          if (!listener.once) {
            remaining.push(listener);
          }
        }

        this.eventListeners.set(message.method, remaining);
      }
    } catch {
      // Ignore malformed CDP payloads.
    }
  }

  private failPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}
