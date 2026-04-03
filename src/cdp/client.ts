export class CDPClient {
  private ws: WebSocket | null = null;
  private url: string;
  private pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  > = new Map();
  private eventListeners: Map<string, ((data: any) => void)[]> = new Map();
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
        for (const listener of listeners) {
          listener(message.params);
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

  on(event: string, callback: (data: any) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  off(event: string, callback: (data: any) => void): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
