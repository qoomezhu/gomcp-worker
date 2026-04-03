export class CDPClient {
  private ws: WebSocket | null = null;
  private url: string;
  private pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  > = new Map();
  
  // 支持 once 选项的监听器结构
  private eventListeners: Map<string, Array<{ callback: (data: any) => void; once: boolean }>> = new Map();
  private connected: boolean = false;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };

      this.ws.onclose = () => {
        this.connected = false;
        // 拒绝所有待处理的请求
        for (const [id, { reject: rej }] of this.pendingRequests) {
          rej(new Error('WebSocket closed'));
        }
        this.pendingRequests.clear();
      };

      this.ws.onerror = (error) => {
        reject(new Error(`WebSocket error: ${error}`));
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  // 带重试的连接方法
  async connectWithRetry(maxRetries = 3): Promise<void> {
    let lastError: Error | undefined;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.connect();
        return;
      } catch (err: any) {
        lastError = err;
        console.warn(`CDP connection attempt ${i + 1} failed: ${err.message}`);
        if (i < maxRetries - 1) {
          // 指数退避：1s, 2s, 4s...
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
      }
    }
    throw lastError || new Error('CDP connection failed after retries');
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // 处理响应
      if (message.id && this.pendingRequests.has(String(message.id))) {
        const { resolve, reject } = this.pendingRequests.get(
          String(message.id)
        )!;
        this.pendingRequests.delete(String(message.id));

        if (message.error) {
          reject(new Error(message.error.message || 'CDP Error'));
        } else {
          resolve(message);
        }
        return;
      }

      // 处理事件
      if (message.method) {
        const listeners = this.eventListeners.get(message.method) || [];
        const toRemove: number[] = [];
        
        for (let i = 0; i < listeners.length; i++) {
          listeners[i].callback(message.params);
          if (listeners[i].once) {
            toRemove.push(i);
          }
        }
        
        // 倒序移除 once 监听器，避免索引偏移
        for (let i = toRemove.length - 1; i >= 0; i--) {
          listeners.splice(toRemove[i], 1);
        }
      }
    } catch {
      // 忽略解析错误
    }
  }

  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.ws || !this.connected) {
      throw new Error('CDP not connected');
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      this.ws!.send(
        JSON.stringify({
          id,
          method,
          params,
        })
      );

      // 设置超时
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(event: string, callback: (data: any) => void, options?: { once?: boolean }): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push({ callback, once: options?.once || false });
  }

  off(event: string, callback: (data: any) => void): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.findIndex(l => l.callback === callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.pendingRequests.clear();
    this.eventListeners.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
