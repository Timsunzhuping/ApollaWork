/** IM 通道适配器抽象（PRD T-205/206）：企业微信 / 钉钉 / 飞书 / mock 统一实现此接口。 */

/** 一条来自 IM 的 @机器人 消息（已由适配器解出明文并过滤非 @ 消息） */
export interface InboundMessage {
  /** 通道名，与 ChannelAdapter.name 一致（wecom | dingtalk | feishu | mock） */
  channel: string;
  /** IM 会话/群 ID，回推时用 */
  chatId: string;
  /** 发送者在该 IM 中的用户 ID */
  userId: string;
  /** 消息正文（已去掉 @机器人 前缀） */
  text: string;
}

export interface ChannelAdapter {
  name: string;
  /** 启动监听（webhook 或长连接）。收到 @机器人 消息时调 onMessage */
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** 回推文本到会话 */
  sendText(chatId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}
