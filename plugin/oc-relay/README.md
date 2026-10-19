# oc-relay

SillyTavern **Server Plugin**：把下游 OpenAI 兼容请求反向代理到 OpenCode Go 上游（`https://opencode.ai/zen/go/v1/chat/completions`），并在转发时补齐上游要求的 OpenCode 身份 / 路由头。

- 零 npm 依赖（只用 Node 内置 `fetch` / `node:crypto`），`pnpm install` / `npm install` 都不需要。
- 随 ST 启动自动加载（`init(router)`，挂载到 `/api/plugins/oc-relay`）。

## 请求链路

```
下游客户端 (ST Custom / opencode CLI / 任意 OpenAI SDK)
  baseURL: https://<ST-host>/api/plugins/oc-relay/<prefix>/v1
        │
        ▼
SillyTavern /api/plugins/oc-relay/<prefix>/v1/chat/completions
  ├─ prefix 解析：路径第一段 → sanitize → [0-9A-Za-z]{1,6}，为空则 default
  │               （请求头 x-opencode-prefix 优先于路径，可覆盖）
  ├─ session 派生：chatKey = 请求头 x-st-chat-key
  │                ?? sha256(system + 首条 user) 短指纹
  │                H = sha256("ses\0" + prefix + "\0" + chatKey)
  │                x-opencode-session = ses_ + (H 前 6 字节 hex, 低 12 bit 固定为 counter≤63) + 14 位 tail
  │  （shape: ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$，同 chat + 同 prefix 恒定，不同 prefix 隔离）
  ├─ x-opencode-request：每请求新生成 msg_ + 12 hex + 14 base62（官方 identifier 同款生成器）
  └─ 透传 Authorization，补 User-Agent: opencode/1.18.31、x-opencode-client: cli、Content-Type: application/json
        │
        ▼
OpenCode Go 上游
  SSE 响应按字节回传（text/event-stream + no-cache + keep-alive + X-Accel-Buffering: no）
  下游断开 → AbortController 中止上游请求
```

## 文件

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | 插件清单（id: `oc-relay`，仅小写字母数字 `-` `_`） |
| `index.js` | 全部逻辑（ESM，无第三方依赖） |
| `README.md` | 本文件 |

## 安装

1. 把整个 `oc-relay/` 文件夹复制到 SillyTavern 的 server plugins 目录（与 `config.yaml` 同级）：

   ```
   <SillyTavern>/plugins/oc-relay/
   ```

   > 注意是 ST 根目录下的 `plugins/`（Server Plugin），不是 `data/<user>/extensions/`（UI 扩展）。

2. 在 `<SillyTavern>/config.yaml` 中开启 Server Plugin：

   ```yaml
   enableServerPlugins: true
   # 可选：关闭启动时自动 git pull 插件目录
   # enableServerPluginsAutoUpdate: false
   ```

3. **重启 SillyTavern**（Server Plugin 只在启动时加载，热重载不生效）。启动日志中应出现：

   ```
   Initializing plugin from .../plugins/oc-relay/index.js
   [oc-relay] mounted at /api/plugins/oc-relay
   ```

4. 客户端（例如 ST 的 **Custom (OpenAI-compatible)** 或其它 OpenAI SDK）里填写：

   | 配置 | 值 |
   | --- | --- |
   | Base URL / custom_url | `http://<ST-host>:8000/api/plugins/oc-relay/default/v1` |
   | API Key | 你的 OpenCode Go API Key（插件原样透传为 `Authorization: Bearer ...`） |
   | Model | 上游支持的模型 ID，如 `deepseek-v4-flash` |

   若客户端不会自动拼接 `/chat/completions`，把地址写成完整端点：
   `http://<ST-host>:8000/api/plugins/oc-relay/default/v1/chat/completions`。

5. 可选请求头：

   | 头 | 说明 |
   | --- | --- |
   | `x-opencode-prefix` | 覆盖 URL 里的 prefix（优先于路径）；用于一个客户端下按项目/角色分出不同上游 session |
   | `x-st-chat-key` | 指定会话绑定 key；同一 key + 同一 prefix ⇒ 同一 `x-opencode-session`。不传则用 `system + 首条 user` 的 sha256 短指纹，同一聊天自然恒定 |

## 端点

| 端点 | 行为 |
| --- | --- |
| `POST /api/plugins/oc-relay/:prefix/v1/chat/completions` | 转发到上游 `/v1/chat/completions`，SSE 字节级透传 |
| `GET  /api/plugins/oc-relay/:prefix/v1/models` | 透传上游模型列表；上游失败时返回最小静态兜底列表 |
| `POST /api/plugins/oc-relay/v1/chat/completions`、`GET /api/plugins/oc-relay/v1/models` | 不带 prefix 的等价路由（等价于 prefix=default，仍可被 `x-opencode-prefix` 覆盖） |

## curl 验证

```bash
curl -N http://127.0.0.1:8000/api/plugins/oc-relay/default/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <OPENCODE_GO_API_KEY>" \
  -d '{"model":"deepseek-v4-flash","stream":true,"messages":[{"role":"system","content":"test"},{"role":"user","content":"hi"}]}'
```

正常时应逐块吐出 `data: {...}` SSE 文本；重启 ST 日志中不应出现 `MissingSessionID` 相关 400。

## ⚠️ R1 / R2：待用户实测确认

- **R1 — CSRF 保护（默认开启，最可能的拦路虎，待实测）**
  SillyTavern 默认启用 CSRF（`config.yaml` 中 `disableCsrfProtection: false`），且该中间件位于插件路由之前。**不带 ST 会话 token 的外部 POST 会被 403 拒绝**（`Invalid CSRF token`）。三种处理方式，任选其一并自行评估安全性：
  1. `config.yaml` 设 `disableCsrfProtection: true`（或启动参数 `--disableCsrf`）后重启 —— 最简单，但降低 ST 的 CSRF 防护；
  2. 外部客户端先 `GET /csrf-token`（带 cookie 容器），之后每个 POST 带 `x-csrf-token: <token>` 与同一 cookie；
  3. 若下游是 ST 前端自身（同源、浏览器已持有 token），一般可正常工作，待实测。
  **本风险未在真实 ST 实例上验证，请在部署时优先确认。**

- **R2 — 请求体与 SSE 中间件（待实测）**
  1. ST 全局 `body-parser`（`server-main.js` 在插件加载前执行）已消费原始请求体，插件只能对 `req.body` 重新 JSON 序列化后转发：语义等价、非字节等价，且受 ST 的 500MB 限制；
  2. ST 全局 `compression()` 中间件可能缓冲 SSE，插件已用 `Cache-Control: no-transform` 绕过（`compression` 会跳过 `no-transform`），并用 `accept-encoding: identity` 禁止上游压缩，但最终流式手感需要在真实 ST 上实测确认；
  3. 反向代理（nginx 等）也需 `proxy_buffering off;` 才能实时出字。

## 其它注意事项

- plugin 路由位于 ST 的登录 / 白名单 / Basic Auth 等中间件之后：多用户模式或开启 `basicAuthMode` / `whitelist` 时，外部客户端必须满足对应认证。
- 仅实现 `chat/completions` 与 `models` 两个端点，不含 Anthropic `/messages` 与 Responses API。
- 下游若自带 `x-opencode-session` / `x-opencode-request`，会被本插件覆盖为本插件派生的值（保证同 prefix + 同 chat 稳定复用上游缓存）。
- 环境变量 `OC_RELAY_UPSTREAM` 可覆盖上游 origin（默认 `https://opencode.ai/zen/go`，一般无需设置）。
- 上游地址与模型 ID 可能随 OpenCode 官方变动；`/v1/models` 的静态兜底列表仅含一个示例模型，实际请以官方文档为准。

## 卸载

删除 `plugins/oc-relay/` 并重启 SillyTavern。
