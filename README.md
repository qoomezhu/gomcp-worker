# gomcp-worker

Cloudflare Workers 实现的 gomcp（MCP Server for Lightpanda Browser）。

## 功能特性

- ✅ 支持 MCP 协议版本 `2025-03-26`
- ✅ Streamable HTTP JSON-RPC
- ✅ 轻量 SSE 握手 / 兼容连接
- ✅ Durable Objects 会话管理
- ✅ CDP WebSocket 客户端（自动重连）
- ✅ HTML → Markdown 转换
- ✅ 会话空闲超时清理
- ✅ 请求取消标记支持

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

```bash
curl -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'
```

## 说明

- `GET /mcp` 和 `GET /sse` 返回轻量 SSE 握手流与 `Mcp-Session-Id`，用于兼容需要建立事件流的客户端。
- 真正的工具调用走 `POST /mcp`。
- `initialize` / `tools/list` / `ping` 不依赖浏览器 CDP 连接；只有 `tools/call` 需要连接浏览器。

## 许可证

Apache-2.0
