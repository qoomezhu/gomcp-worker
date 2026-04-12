# gomcp-worker 修正设计（方案 A）

日期：2026-04-12

## 1. 背景

当前仓库存在几类会影响部署与运行的关键问题：

1. `wrangler.toml` 已声明 Durable Object 绑定，但缺少迁移配置，部署存在失败风险。
2. SSE 初始化通过 Worker 将 `WritableStreamDefaultWriter` 传给 Durable Object，和 Cloudflare Durable Object RPC 的推荐边界不一致，运行存在失败风险。
3. 多处 `Runtime.evaluate` 返回值提取路径错误，导致页面标题、HTML、链接和搜索结果可能始终为空或异常。
4. MCP 握手与工具列表阶段不应依赖 CDP 连接，但当前实现会在所有请求前尝试连接 CDP，导致后端浏览器异常时客户端连初始化都可能失败。
5. 页面导航超时场景下事件监听器清理不完整，存在脏监听风险。

本设计目标是以尽量小的改动修复以上关键问题，适合直接提交到 `main`。

## 2. 目标

本次修正的目标：

- 让项目可以正确声明并部署 Durable Object。
- 让 `initialize` / `tools/list` / `ping` / `notifications/initialized` 在 CDP 不可用时仍然可用。
- 修复 `goto` / `search` / `markdown` / `links` 的核心取值问题。
- 去除当前高风险的 SSE writer 跨边界传递方式。
- 保持当前 API 结构尽量稳定，避免进行大规模重构。

## 3. 非目标

以下内容不在本次修正范围内：

- 不重写整个 SSE / 会话总线架构。
- 不新增完整测试基建或 CI 流程。
- 不引入新的 MCP 工具或外部依赖。
- 不实现主动的 CDP 健康探测握手。

## 4. 方案选择

### 备选方案

#### 方案 A：最小可用修正（采用）
- 补 Durable Object migration。
- 修复 `Runtime.evaluate` 返回值提取。
- 将 CDP 连接延后到 `tools/call`。
- 取消 DO 内持有 SSE writer 的做法。
- 将 `GET /mcp` 与 `GET /sse` 改为 Worker 侧轻量 SSE 响应。
- 修复监听器清理和类型问题。

优点：改动最小、风险最低、适合直接推送到 `main`。

缺点：SSE 仍为轻量实现，不包含复杂通知分发。

#### 方案 B：结构性重写
- 让 DO 接管更完整的 SSE 生命周期和事件分发。

未采用原因：改动过大，不适合直接在本轮修正中提交到 `main`。

#### 方案 C：保守止血
- 禁用 SSE，只保留 POST JSON-RPC。

未采用原因：会导致明显功能回退，与当前项目定位不符。

## 5. 设计

### 5.1 路由与传输层

保留当前路由：

- `POST /mcp`：JSON-RPC 请求入口。
- `DELETE /mcp`：关闭会话。
- `GET /mcp`：SSE/兼容连接入口。
- `GET /sse`：旧版兼容 SSE 入口。
- `GET /health`：基础健康检查。

修改点：

- `GET /mcp` 与 `GET /sse` 不再将 `WritableStreamDefaultWriter` 传入 Durable Object。
- Worker 直接创建 SSE `Response`。
- 轻量 SSE 响应包含：
  - 一个 `endpoint` 事件，用于建立连接；
  - 周期性 keepalive comment，降低空闲连接被中间层回收的概率；
  - `Mcp-Session-Id` 响应头，用于让客户端继续复用会话。

这样做的目的是消除当前 DO RPC 边界上的高风险实现，同时尽量保持接口对客户端的兼容性。

### 5.2 MCP 请求处理边界

`MCPSession.handleRequest()` 的逻辑调整为：

1. 先更新会话活跃时间。
2. 处理不依赖 CDP 的请求：
   - `initialize`
   - `tools/list`
   - `ping`
   - `notifications/initialized`
   - `notifications/cancelled`
3. 仅在 `tools/call` 分支中调用 `ensureCDPConnection()`。

这样可保证：

- 浏览器后端不可用时，客户端仍能完成基础 MCP 握手与工具发现。
- 真正执行工具时再返回明确的 CDP 错误。

### 5.3 CDP evaluate 结果提取

新增统一 helper：

```ts
function getEvalValue(resp: any) {
  return resp?.result?.result?.value;
}
```

统一替换以下位置的结果提取：

- 页面标题：`document.title`
- 页面 HTML 抓取
- 链接数组抓取
- DuckDuckGo 搜索结果抓取

目标是修复当前由于结果层级读取错误导致的空结果问题。

### 5.4 导航与监听器清理

`navigateTo()` 中 `Page.loadEventFired` 监听器调整为：

- 注册显式 handler。
- 成功加载时移除监听器并清理 timeout。
- 超时时也移除监听器。

这样可避免超时场景下残留监听器污染后续导航。

### 5.5 类型修正

`getPageLinks()` 的返回值类型从 `Promise<string[]>` 更正为：

```ts
Promise<Array<{ href: string; text: string }>>
```

保证类型定义与实际返回值一致。

### 5.6 部署配置修正

在 `wrangler.toml` 中新增 Durable Object migration：

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["MCPSession"]
```

如当前项目实际使用的 Durable Object 存储模型与 SQLite 配置不符，则在实现时按 Cloudflare 当前要求修正为匹配的 migration 字段。默认按当前新版 Durable Object 模式处理。

### 5.7 文档同步

README 同步更新以下内容：

- 说明 SSE 为轻量兼容实现。
- 保留现有 MCP 工具文档。
- 增加 Durable Object migration / 部署注意事项。
- 避免 README 对当前 SSE/会话能力做出过强承诺。

## 6. 数据流

### 6.1 JSON-RPC 工具调用

1. 客户端 `POST /mcp`
2. Worker 根据 `Mcp-Session-Id` 获取或创建 DO stub
3. Worker 将 JSON-RPC 请求转发给 `MCPSession.handleRequest()`
4. DO 在 `tools/call` 时建立 CDP 连接
5. 工具执行后返回 MCP 格式响应
6. Worker 将 JSON 响应返回给客户端

### 6.2 SSE 建连

1. 客户端 `GET /mcp` 或 `GET /sse`
2. Worker 创建 SSE `ReadableStream`
3. Worker 立即写入 `endpoint` 事件
4. Worker 设置 `Mcp-Session-Id` 响应头
5. Worker 通过 keepalive comment 保持连接活跃

## 7. 错误处理

- JSON-RPC 请求格式校验保持不变。
- CDP 不可用时：
  - `initialize` / `tools/list` 等非工具请求仍成功。
  - `tools/call` 返回明确的 `CDP Connection Error`。
- `Runtime.evaluate` 返回空值时：
  - 标题回退为 `Unknown`
  - HTML/链接/搜索结果回退为空字符串或空数组
- SSE 初始化失败时返回 JSON 错误响应。

## 8. 验证策略

本次修正至少验证以下场景：

1. `GET /mcp` 与 `GET /sse` 可返回 SSE 响应和 `Mcp-Session-Id`。
2. 未配置或错误配置 `CDP_URL` 时，`initialize` 与 `tools/list` 可正常返回。
3. `tools/call` 在 CDP 不可用时返回连接错误。
4. 页面标题、HTML、链接与搜索结果的 `Runtime.evaluate` 提取路径正确。
5. 导航超时后不会残留监听器影响下一次导航。
6. `wrangler.toml` 包含可部署的 Durable Object migration。

## 9. 风险与后续工作

### 当前风险

- 轻量 SSE 实现不包含复杂服务端主动推送能力。
- `/health` 仍不进行真实 CDP 探活，仅反映基础配置状态。
- 缺少自动化测试，回归主要依赖手动验证。

### 后续可选增强

- 为 DO/Worker/CDP 交界处增加自动化测试。
- 将 SSE 会话管理统一收敛到更清晰的架构中。
- 增加真实的 CDP 连接健康探测。
