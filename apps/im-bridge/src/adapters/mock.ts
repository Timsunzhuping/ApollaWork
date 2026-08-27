import type { ChannelAdapter, InboundMessage } from '../channel.js';

/**
 * 进程内测试通道：不起服务器、不出网。
 * inject() 模拟一条 @机器人 消息进入通道；sendText 的回推全部存进 sent 供断言。
 */
export class MockAdapter implements ChannelAdapter {
  readonly name = 'mock';
  /** 已回推的消息（测试断言用） */
  readonly sent: { chatId: string; text: string }[] = [];
  private onMessage?: (msg: InboundMessage) => Promise<void>;

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
  }

  /** 模拟来消息。返回 bridge 的完整处理 Promise，测试可 await 到回推完成。 */
  async inject(msg: Partial<InboundMessage> & { text: string }): Promise<void> {
    if (!this.onMessage) throw new Error('mock 通道尚未 start');
    await this.onMessage({
      channel: this.name,
      chatId: msg.chatId ?? 'chat_1',
      userId: msg.userId ?? 'user_1',
      text: msg.text,
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async stop(): Promise<void> {
    this.onMessage = undefined;
  }
}
