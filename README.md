# gomcp-worker

Cloudflare Workers 实现的 gomcp (MCP Server for Lightpanda Browser)。

## 功能特性

- ✅ 支持 MCP 协议版本 `2025-03-26`
- ✅ Streamable HTTP 传输
- ✅ SSE 传输
- ✅ Durable Objects 状态管理
- ✅ CDP WebSocket 客户端 (自动重连/心跳)
- ✅ 全球 Edge 部署
- ✅ Turndown HTML → Markdown 转换
- ✅ 会话空闲自动清理
- ✅ 请求取消支持

## 可用工具

| 工具 | 描述 | 必需参数 |
|------|------|----------|
| `goto` | 导航到指定 URL | `url` |
| `search` | 使用 DuckDuckGo 搜索 | `text` |
| `markdown` | 获取页面内容的 Markdown | — |
| `links` | 提取页面所有链接 | — |

## 部署

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
# 设置 Lightpanda 浏览器的 CDP WebSocket URL
wrangler secret set CDP_URL
# 输入: wss://your-lightpanda-instance:9222
```

### 3. 本地开发

```bash
npm run dev
```

### 4. 部署到 Cloudflare

```bash
npm run deploy
```

## 环境变量配置

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `CDP_URL` | Lightpanda 浏览器 CDP WebSocket URL | 无 (必填) |
| `SESSION_IDLE_TIMEOUT_MS` | 会话空闲超时时间 (毫秒) | 600000 (10 分钟) |
| `CDP_COMMAND_TIMEOUT_MS` | CDP 命令超时时间 (毫秒) | 30000 (30 秒) |
| `MAX_HTML_LENGTH` | 页面内容最大长度 (字节) | 500000 (500KB) |

## 使用示例

### MCP 客户端配置

```json
{
  "mcpServers": {
    "lightpanda": {
      "url": "https://your-worker.workers.dev/mcp"
    }
  }
}
```

### 直接调用

```bash
# 初始化
curl -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'

# 列出工具
curl -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: your-session-id" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}'
```

## 架构说明

```
MCP Client
    ↓ (HTTP/SSE)
Cloudflare Workers (Edge)
    ↓ (WebSocket)
Lightpanda Browser (CDP)
```

### 状态管理

- 使用 **Durable Objects** 管理 MCP Session 状态
- 每个会话有独立的 CDP WebSocket 连接
- 页面状态在会话间持久化
- 空闲会话自动清理，节省资源

## 免费额度

### Durable Objects (Workers Free Plan)

| 资源 | 每日免费额度 |
|------|-------------|
| 请求数 | 100,000 次/天 |
| 计算量 | 13,000 GB-s/天 |
| SQLite 行读取 | 5,000,000 次/天 |
| SQLite 行写入 | 100,000 次/天 |
| 总存储 | 5 GB |

## 许可证

Apache-2.0
