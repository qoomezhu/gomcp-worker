# gomcp-worker

Cloudflare Workers 版本的 gomcp（Lightpanda Browser 的 MCP Server）。这次总算把最致命的坑补上了，不再是那种“接口能回 200，但灵魂已经离职”的半成品。

## 功能特性

- ✅ 支持 MCP 协议版本 `2025-03-26`
- ✅ Streamable HTTP JSON-RPC
- ✅ `initialize` 分配会话，后续请求强制复用 `Mcp-Session-Id`
- ✅ Durable Objects 会话生命周期管理（关闭/过期后返回 `404`）
- ✅ 根 CDP WebSocket 自动 `Target.createTarget` + `Target.attachToTarget`
- ✅ `resources/list` / `prompts/list` 空响应兼容
- ✅ `notifications/cancelled` 使用正确的 `requestId`
- ✅ 工具执行失败按 `result.isError` 返回
- ✅ Workers 兼容的 HTML → Markdown 转换（优先纯解析库，失败时回退轻量转换器）
- ✅ 轻量 SSE 握手入口：`GET /mcp` / `GET /sse`

## 可用工具

| 工具 | 描述 | 必需参数 |
|------|------|----------|
| `goto` | 导航到指定 URL | `url` |
| `search` | 使用 DuckDuckGo 搜索 | `text` |
| `markdown` | 获取当前页面 Markdown | — |
| `links` | 提取当前页面链接 | — |

## 部署

### 1. 安装依赖

```bash
npm install
```

### 2. 配置密钥

```bash
wrangler secret set CDP_URL
```

示例值：

```text
wss://your-lightpanda-instance:9222
```

> `CDP_URL` 应指向 **浏览器根 WebSocket**。Worker 会在连上后自动创建 target 并 attach，不需要你手搓 page session。

### 3. 本地开发

```bash
npm run dev
```

### 4. 部署到 Cloudflare

```bash
npm run deploy
```

> 注意：`wrangler.toml` 已包含 `MCPSession` 的 Durable Object migration。后续如重命名 Durable Object 类，必须继续追加 migration，而不是修改已有 tag。

## MCP 客户端示例

```json
{
  "mcpServers": {
    "lightpanda": {
      "url": "https://your-worker.workers.dev/mcp"
    }
  }
}
```

## 直接调用示例

### 1. 初始化并拿到 `Mcp-Session-Id`

```bash
curl -i -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'
```

### 2. 带上 `Mcp-Session-Id` 调用后续方法

```bash
curl -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id-from-initialize>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}'
```

## 说明

- `initialize` 会返回新的 `Mcp-Session-Id`；后续 `tools/list` / `ping` / `tools/call` / `GET /mcp` / `DELETE /mcp` 都必须带上它。
- `GET /mcp` 和 `GET /sse` 是轻量 SSE 握手入口，不负责旧版 `/messages` 传输。
- `initialize` / `tools/list` / `ping` / `resources/list` / `prompts/list` 不依赖 CDP；只有 `tools/call` 需要连接浏览器。
- `resources/list` 和 `prompts/list` 当前返回空数组，这是故意的，不是服务器在摆烂——虽然看起来很像。

## 许可证

Apache-2.0
