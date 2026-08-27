# @apolla/im-bridge

IM 通道桥接服务（PRD T-205/206）：把企业微信 / 钉钉 / 飞书群里 @机器人 的消息转成 Apolla 任务，任务完成后把摘要与产物下载链接回推到群里。

## 架构

```
IM（@机器人）
   │  webhook 回调（明文 JSON / 各家原生事件）
   ▼
ChannelAdapter（wecom | dingtalk | feishu | mock）
   │  InboundMessage { channel, chatId, userId, text }
   ▼
Bridge（src/bridge.ts）
   ├─ 选工作区：APOLLA_WORKSPACE_ID，未配置则 GET /workspaces 取第一个
   ├─ POST /workspaces/:ws/sessions → POST /sessions/:id/tasks（mode 默认 auto）
   ├─ 轮询 GET /tasks/:id（每 3s，最多 10 分钟）；taskId↔IM 消息的关联记在内存 Map
   └─ 终态回推：
        completed → 「✅ 任务完成：{summary 前 300 字}」+ 每个产物一行
                    「- {title}: {APOLLA_PUBLIC_URL}/api/v1/workspaces/{ws}/file?path=...」
        failed/cancelled/超时/API 出错 → 「❌ 任务失败：{原因}」
   ▼
ChannelAdapter.sendText（各家机器人 webhook；未配置则只打日志）
```

- 三个真实适配器共享一个 `node:http` 回调服务器（`src/adapters/http-util.ts`），默认同端口 **3210** 不同路径：`/wecom/callback`、`/dingtalk/callback`、`/feishu/callback`。
- 回调收到即应答（各家都要求 3~5s 内响应），任务处理与回推异步进行。
- 「只响应 @机器人」由适配器 / IM 平台负责：企微应用消息与钉钉 outgoing 机器人本身只推送 @ 消息；飞书建议只订阅「接收群聊中 @机器人 消息」事件。
- 零第三方运行时依赖：全局 `fetch` + `node:http` + `node:crypto`。

## 启动

```bash
pnpm --filter @apolla/im-bridge run build
APOLLA_API=http://localhost:3001/api/v1 \
APOLLA_PUBLIC_URL=https://apolla.example.com \
CHANNELS=wecom,dingtalk,feishu \
pnpm --filter @apolla/im-bridge run start
```

| 环境变量                                       | 默认                           | 说明                                                              |
| ---------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `APOLLA_API`                                   | `http://localhost:3001/api/v1` | Apolla server REST 根地址                                         |
| `APOLLA_PUBLIC_URL`                            | `APOLLA_API` 去掉 `/api/v1`    | 拼产物下载链接的对外地址（群成员点得开的那个域名）                |
| `APOLLA_WORKSPACE_ID`                          | 空（取第一个工作区）           | 默认工作区                                                        |
| `APOLLA_TASK_MODE`                             | `auto`                         | 建任务的权限模式（IM 场景无人守着审批，建议 auto）                |
| `CHANNELS`                                     | `wecom,dingtalk,feishu`        | 启用的通道，可加 `mock` 做冒烟                                    |
| `WECOM_PORT` / `DINGTALK_PORT` / `FEISHU_PORT` | `3210`                         | 回调端口；相同端口时共享一个 HTTP 服务器                          |
| `WECOM_WEBHOOK_URL`                            | 空（只打日志）                 | 企微群机器人 webhook                                              |
| `DINGTALK_WEBHOOK_URL` / `DINGTALK_SECRET`     | 空（只打日志）                 | 钉钉自定义机器人 webhook；配 SECRET 时按「加签」附 timestamp+sign |
| `FEISHU_WEBHOOK_URL`                           | 空（只打日志）                 | 飞书自定义机器人 webhook                                          |

本地冒烟（不接真实 IM）：

```bash
curl -X POST localhost:3210/wecom/callback -H 'content-type: application/json' \
  -d '{"chatId":"g1","userId":"u1","text":"帮我调研竞品"}'
```

测试：`pnpm --filter @apolla/im-bridge run test`（mock 通道 + 本地假 Apolla API，不依赖真实 server 与外网）。

## 三通道真实凭据配置

### 企业微信（回调模式）

1. 企微管理后台 → 应用管理 → 自建应用 → 「接收消息」设置回调 URL：`https://<你的域名>/wecom/callback`（需公网 HTTPS，本地开发可用内网穿透）。
2. 后台生成 **Token** 与 **EncodingAESKey**：真实回调是 XML + AES-256-CBC 加密，需先校验 `msg_signature = sha1(sort(token, timestamp, nonce, encrypt))` 再解密。当前骨架的 `verifySignature()` 直接放行、只接受已解密的明文 JSON `{chatId,userId,text}`（见下方边界），配好 Token/AESKey 后在 `src/adapters/wecom.ts` 补齐。
3. 回推：群里添加「群机器人」，复制 webhook 地址填到 `WECOM_WEBHOOK_URL`。注意群机器人 webhook 绑定固定群；要按 chatId 回任意会话需改用企业应用消息 API（access_token + appchat/send）。

### 钉钉（outgoing + 自定义机器人 webhook）

1. 收消息：群设置 → 机器人 → 添加「自定义机器人」并开启 **Outgoing** 机制（或用企业内部机器人），回调地址填 `https://<你的域名>/dingtalk/callback`。outgoing 只会推送 @机器人 的消息，原生消息体 `{conversationId, senderStaffId, text:{content}}` 已能直接解析。
2. 回推：同一个（或另一个）自定义机器人的 webhook 填到 `DINGTALK_WEBHOOK_URL`；安全设置选「加签」时把密钥填到 `DINGTALK_SECRET`——本包已实现签名：`sign = base64(HMAC-SHA256("{timestamp}\n{secret}", secret))`，自动附加到 webhook URL。
3. 入向校验：outgoing 回调头部的 `timestamp`/`sign` 用同一算法（密钥为机器人 appSecret）验证，`src/adapters/dingtalk.ts` 的 `verifyInbound()` 留有 TODO。

### 飞书（事件订阅）

1. 飞书开放平台 → 创建企业自建应用 → 添加「机器人」能力。
2. 「事件与回调」→ 请求地址填 `https://<你的域名>/feishu/callback`：保存时飞书会 POST `{type:"url_verification", challenge}`，本服务已实现原样回显 challenge，可直接通过验证。
3. 订阅事件 **im.message.receive_v1**（建议只勾「接收群聊中 @机器人 的消息」，飞书替你过滤非 @ 消息），并授予 `im:message` 读写权限。适配器已 best-effort 解析该事件（chat_id / open_id / content.text，去掉 `@_user_N` 占位）。
4. 回推：群里添加「自定义机器人（Custom Bot）」，webhook 填到 `FEISHU_WEBHOOK_URL`。

## 当前实现边界

- **签名校验未实现**：企微 `verifySignature()`、钉钉 `verifyInbound()`、飞书 Verification Token 均为 TODO 直接放行——只能在内网/开发环境或有前置校验网关时使用；企微/飞书的 AES 解密（EncodingAESKey / Encrypt Key）同样未实现，当前依赖明文 JSON。
- **回推走群机器人 webhook**：企微/钉钉/飞书的 webhook 都绑定固定群，`chatId` 不参与寻址；跨群精确回推需换成各家的应用消息 API。
- **任务关联只在内存**：taskId ↔ IM 消息的 Map 不落库，进程重启后进行中任务的回推会丢失。
- **一问一答**：每条消息新建一个 session，暂不支持在 IM 里多轮追问同一任务、审批或取消。
- 轮询参数（3s / 10 分钟）目前只在 `BridgeConfig` 可调，未暴露环境变量。
