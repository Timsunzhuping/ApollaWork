# @apolla/im-bridge

IM 通道桥接服务（PRD T-205/206）：把企业微信 / 钉钉 / 飞书群里 @机器人 的消息转成 Apolla 任务，任务完成后把摘要与产物下载链接回推到群里。

> ⚠️ **回调端点等价于「远程执行入口」**：一条入向消息会创建一个 Apolla 任务，而 Agent 可以执行 Bash。
> 因此**入向验签是生产 P0 安全项**——未验签的回调端点暴露到公网 = 未授权 RCE。
> 本服务的默认行为是**失败关闭**：没配密钥就拒绝一切回调（详见「安全默认值」）。

## 架构

```
IM（@机器人）
   │  webhook 回调（各家原生签名 + 加密事件）
   ▼
入向验签（src/adapters/verify-util.ts + 各适配器）—— 不通过直接 401，绝不进入下一步
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

- 三个真实适配器共享一个 `node:http` 回调服务器（`src/adapters/http-util.ts`），默认同端口 **3210** 不同路径：`/wecom/callback`、`/dingtalk/callback`、`/feishu/callback`（企微另有 `GET /wecom/callback` 用于后台 URL 校验）。
- 回调收到即应答（各家都要求 3~5s 内响应），任务处理与回推异步进行。
- 「只响应 @机器人」由适配器 / IM 平台负责：企微应用消息与钉钉 outgoing 机器人本身只推送 @ 消息；飞书建议只订阅「接收群聊中 @机器人 消息」事件。
- 零第三方运行时依赖：全局 `fetch` + `node:http` + `node:crypto`（验签与 AES 全部手写，不引 SDK / xml 库）。

## 安全默认值

| 规则                   | 行为                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **失败关闭**           | 通道密钥未配置 → 该通道的所有回调回 `401`，并在启动时与每次拒绝时打警告。**绝不放行**。                                              |
| **防重放**             | 所有带时间戳的回调做 `\|now - timestamp\| ≤ 300s` 新鲜度检查（企微/飞书按秒、钉钉按毫秒，自动归一）。超窗即使签名合法也拒绝。        |
| **防时序侧信道**       | 签名比较一律走 `crypto.timingSafeEqual`；长度不等先返回 `false`（`timingSafeEqualStr`）。                                            |
| **body 上限**          | 1 MB，超限回 `413`。                                                                                                                 |
| **日志不含秘密**       | 验签失败记 `[通道] 拒绝回调：{原因}（来源 {IP}）`；**不记** token / AESKey / 签名原文。来源 IP 有反代时取 `X-Forwarded-For` 第一跳。 |
| **配置错误也失败关闭** | 例如 `WECOM_AES_KEY` 不是合法 43 位 EncodingAESKey → 打 `console.error` 并按「未配置」处理（拒绝一切回调），不静默降级为放行。       |

三通道各自实现的算法：

| 通道     | 入向校验                                                                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 企业微信 | `msg_signature == sha1(sort(token, timestamp, nonce, encrypt).join(''))`，再 AES-256-CBC 解密（key = `base64decode(EncodingAESKey + '=')`，iv = key 前 16 字节，32 字节分组 PKCS#7）；明文去 16 字节随机前缀 + 4 字节网络序长度，尾部 `receiveid` 与 `WECOM_CORP_ID` 比对。GET 与 POST 同一套。      |
| 钉钉     | 请求头 `timestamp` / `sign`；`sign == base64(HMAC-SHA256(timestamp + "\n" + appSecret, key = appSecret))`。                                                                                                                                                                                          |
| 飞书     | 请求头 `X-Lark-Request-Timestamp` / `X-Lark-Request-Nonce` / `X-Lark-Signature`；`sha256(timestamp + nonce + encryptKey + rawBody)`。body 为 `{"encrypt":"..."}` 时 AES-256-CBC 解密（key = `sha256(encryptKey)`，密文前 16 字节是 iv）。另可校验 body 内的 `token`（v1 顶层 / v2 在 `header` 内）。 |

> 验签用的是**原始 body 字节**（`RouteContext.raw`），不是 `JSON.parse` 再 `stringify` 的结果——后者会改变字节序列导致签名必然对不上。

### ⚠️ 开发开关（生产环境绝不可开）

`WECOM_INSECURE_PLAINTEXT=1` / `DINGTALK_INSECURE_PLAINTEXT=1` / `FEISHU_INSECURE_PLAINTEXT=1`
只在**该通道未配置任何密钥**时生效，作用是接受未验签的明文 JSON `{chatId, userId, text}` 以便本地 curl 冒烟。

**风险**：开启后该回调路径上**任何人 POST 一次即可创建 Apolla 任务并驱动 Agent 执行 Bash**，等同于把 RCE 入口开放给能连到该端口的所有人。因此：

- 只在 `127.0.0.1` / 隔离开发环境使用，**永远不要**在能被公网或办公网访问的实例上开；
- 开启时进程会打一条醒目警告，请确保生产日志里出现这条警告即视为事故；
- 配置了真实密钥后开关自动失效（有密钥就一定走验签，不存在「配了密钥又放行」的路径）。

## 启动

```bash
pnpm --filter @apolla/im-bridge run build
APOLLA_API=http://localhost:3001/api/v1 \
APOLLA_PUBLIC_URL=https://apolla.example.com \
CHANNELS=wecom,dingtalk,feishu \
WECOM_TOKEN=... WECOM_AES_KEY=... WECOM_CORP_ID=... \
DINGTALK_APP_SECRET=... \
FEISHU_ENCRYPT_KEY=... FEISHU_VERIFICATION_TOKEN=... \
pnpm --filter @apolla/im-bridge run start
```

| 环境变量                                       | 默认                           | 说明                                                                      |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `APOLLA_API`                                   | `http://localhost:3001/api/v1` | Apolla server REST 根地址                                                 |
| `APOLLA_PUBLIC_URL`                            | `APOLLA_API` 去掉 `/api/v1`    | 拼产物下载链接的对外地址（群成员点得开的那个域名）                        |
| `APOLLA_WORKSPACE_ID`                          | 空（取第一个工作区）           | 默认工作区                                                                |
| `APOLLA_TASK_MODE`                             | `auto`                         | 建任务的权限模式（IM 场景无人守着审批，建议 auto）                        |
| `CHANNELS`                                     | `wecom,dingtalk,feishu`        | 启用的通道，可加 `mock` 做冒烟                                            |
| `WECOM_PORT` / `DINGTALK_PORT` / `FEISHU_PORT` | `3210`                         | 回调端口；相同端口时共享一个 HTTP 服务器                                  |
| **`WECOM_TOKEN`**                              | 空 → **拒绝所有回调**          | 企微后台「接收消息」的 Token                                              |
| **`WECOM_AES_KEY`**                            | 空 → **拒绝所有回调**          | 企微 43 位 EncodingAESKey                                                 |
| `WECOM_CORP_ID`                                | 空（不校验 receiveid）         | 企业 CorpID；配置后强制比对密文尾部 receiveid，建议配上                   |
| **`DINGTALK_APP_SECRET`**                      | 空 → **拒绝所有回调**          | 钉钉 outgoing 机器人的 appSecret（**入向**验签用）                        |
| **`FEISHU_ENCRYPT_KEY`**                       | 空                             | 飞书事件订阅 Encrypt Key（验签 + 解密）                                   |
| **`FEISHU_VERIFICATION_TOKEN`**                | 空                             | 飞书 Verification Token；与 Encrypt Key **两者全空 → 拒绝所有回调**       |
| `WECOM_WEBHOOK_URL`                            | 空（只打日志）                 | 企微群机器人 webhook（回推）                                              |
| `DINGTALK_WEBHOOK_URL` / `DINGTALK_SECRET`     | 空（只打日志）                 | 钉钉自定义机器人 webhook（回推）；配 SECRET 时按「加签」附 timestamp+sign |
| `FEISHU_WEBHOOK_URL`                           | 空（只打日志）                 | 飞书自定义机器人 webhook（回推）                                          |
| `*_INSECURE_PLAINTEXT`                         | 关闭                           | 开发开关，见上方 ⚠️ 风险提示                                              |

本地冒烟（不接真实 IM，需显式开开发开关）：

```bash
WECOM_INSECURE_PLAINTEXT=1 CHANNELS=wecom pnpm --filter @apolla/im-bridge run start
curl -X POST localhost:3210/wecom/callback -H 'content-type: application/json' \
  -d '{"chatId":"g1","userId":"u1","text":"帮我调研竞品"}'
# 不开开关时同一条请求会得到 401 invalid signature / callback not configured
```

测试：`pnpm --filter @apolla/im-bridge run test`（`bridge.test.ts` 用 mock 通道 + 本地假 Apolla API；`signature.test.ts` 自造三家合法请求再逐项篡改，含腾讯官方 WXBizMsgCrypt 示例向量。全程离线，不依赖真实 server 与外网）。

## 三通道密钥配置步骤

### 企业微信（回调模式）

1. 企微管理后台 → 应用管理 → 自建应用 → 「接收消息」→ 设置 API 接收：回调 URL 填 `https://<你的域名>/wecom/callback`（需公网 HTTPS，本地开发可用内网穿透）。
2. 点「随机获取」生成 **Token** 与 **EncodingAESKey**（43 位），分别填入 `WECOM_TOKEN` 与 `WECOM_AES_KEY`；「我的企业」页的 **CorpID** 填入 `WECOM_CORP_ID`。
3. **先启动本服务再点保存**：企微保存时会发 `GET /wecom/callback?msg_signature=..&timestamp=..&nonce=..&echostr=..`，本服务验签通过后解密 echostr 并明文回显；密钥填错会直接 401，后台会提示校验失败。
4. 之后的消息回调是 `POST /wecom/callback`，XML body 的 `<Encrypt>` 会被验签 + 解密，解析 `MsgType`/`FromUserName`/`Content`/`ChatId`（群聊有 `ChatId`，单聊回落到 `FromUserName`）；非文本消息照常回 200 但不建任务，避免企微重试。
5. 回推：群里添加「群机器人」，复制 webhook 地址填到 `WECOM_WEBHOOK_URL`。注意群机器人 webhook 绑定固定群；要按 chatId 回任意会话需改用企业应用消息 API（access_token + appchat/send）。

### 钉钉（outgoing + 自定义机器人 webhook）

1. 收消息：群设置 → 机器人 → 添加「自定义机器人」并开启 **Outgoing** 机制（或用企业内部机器人），回调地址填 `https://<你的域名>/dingtalk/callback`。outgoing 只会推送 @机器人 的消息。
2. 把该机器人的 **appSecret** 填入 `DINGTALK_APP_SECRET`。钉钉会在请求头带 `timestamp` 与 `sign`，本服务用同一算法校验并做 ±5 分钟新鲜度检查。
3. 原生消息体 `{conversationId, senderStaffId, text:{content}}` 验签通过后直接解析；也兼容明文 `{chatId,userId,text}`（仍需先过验签）。
4. 回推：把自定义机器人的 webhook 填到 `DINGTALK_WEBHOOK_URL`；安全设置选「加签」时把密钥填到 `DINGTALK_SECRET`——本包已实现出向签名 `sign = base64(HMAC-SHA256("{timestamp}\n{secret}", secret))`，自动附加到 webhook URL。
   > 出向的 `DINGTALK_SECRET` 与入向的 `DINGTALK_APP_SECRET` 是两个不同的密钥，别填反了。

### 飞书（事件订阅）

1. 飞书开放平台 → 创建企业自建应用 → 添加「机器人」能力。
2. 「事件与回调」→ 请求地址填 `https://<你的域名>/feishu/callback`；在同一页复制 **Encrypt Key** 与 **Verification Token**，填入 `FEISHU_ENCRYPT_KEY` 与 `FEISHU_VERIFICATION_TOKEN`。
   - **强烈建议配置 Encrypt Key**：只配 Verification Token 时飞书不发签名头，校验强度只等同于「共享明文口令」，服务启动时会打警告。
3. **先启动本服务再点保存**：飞书保存时会 POST `url_verification` 挑战（配了 Encrypt Key 则 body 是 `{"encrypt":"..."}`），本服务验签 → 解密 → 回显 `challenge`。
4. 订阅事件 **im.message.receive_v1**（建议只勾「接收群聊中 @机器人 的消息」，飞书替你过滤非 @ 消息），并授予 `im:message` 读写权限。适配器解析 `chat_id` / `open_id` / `content.text`，去掉 `@_user_N` 占位。
5. 回推：群里添加「自定义机器人（Custom Bot）」，webhook 填到 `FEISHU_WEBHOOK_URL`。

## 当前实现边界

- **回推走群机器人 webhook**：企微/钉钉/飞书的 webhook 都绑定固定群，`chatId` 不参与寻址；跨群精确回推需换成各家的应用消息 API。
- **飞书自定义机器人 webhook 的出向签名未实现**：若在飞书群机器人上开启「签名校验」，需要额外实现出向 `timestamp+sign`，当前只支持「自定义关键词 / IP 白名单」两种安全设置。
- **任务关联只在内存**：taskId ↔ IM 消息的 Map 不落库，进程重启后进行中任务的回推会丢失。
- **一问一答**：每条消息新建一个 session，暂不支持在 IM 里多轮追问同一任务、审批或取消。
- **没有速率限制 / 去重**：验签只挡住「不持有密钥的人」，持有密钥的 IM 平台重复投递（同一 `MsgId`/`event_id`）会重复建任务；限流与幂等留待后续任务。
- 轮询参数（3s / 10 分钟）目前只在 `BridgeConfig` 可调，未暴露环境变量。
