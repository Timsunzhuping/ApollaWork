import OpenAI from 'openai';

/** 统一的对话消息（子集，够 Agent Loop 用） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ModelDelta {
  textDelta?: string;
}

export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inTokens: number; outTokens: number };
  finishReason: string;
}

export interface ChatModel {
  readonly name: string;
  chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onDelta: (d: ModelDelta) => void,
    signal: AbortSignal,
  ): Promise<ModelResult>;
}

/** 把内部 ChatMessage 映射为 OpenAI 线格式（tool_calls 需嵌套 function 结构）。 */
function toOpenAIMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        })),
      } as OpenAI.ChatCompletionMessageParam;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id!, content: m.content } as OpenAI.ChatCompletionMessageParam;
    }
    return { role: m.role, content: m.content } as OpenAI.ChatCompletionMessageParam;
  });
}

/** OpenAI 兼容模型（经 LiteLLM 或直连 vLLM/Ollama）。支持流式 + function calling。 */
export class OpenAICompatModel implements ChatModel {
  private client: OpenAI;
  constructor(
    public readonly name: string,
    baseURL: string,
    apiKey: string,
  ) {
    this.client = new OpenAI({ baseURL, apiKey, timeout: 300_000, maxRetries: 3 });
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onDelta: (d: ModelDelta) => void,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.name,
        messages: toOpenAIMessages(messages),
        tools: tools.length
          ? tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            }))
          : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.3,
      },
      { signal },
    );

    let text = '';
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let usage = { inTokens: 0, outTokens: 0 };
    let finishReason = 'stop';

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        onDelta({ textDelta: choice.delta.content });
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolAcc.set(idx, cur);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inTokens: chunk.usage.prompt_tokens ?? 0,
          outTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }

    const toolCalls: ToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, v]) => ({ id: v.id || `call_${i}`, name: v.name, arguments: v.args || '{}' }));

    // 估算 token（端点未回 usage 时）
    if (usage.inTokens === 0) {
      const approx = messages.reduce((n, m) => n + Math.ceil((m.content?.length ?? 0) / 3), 0);
      usage = { inTokens: approx, outTokens: Math.ceil(text.length / 3) };
    }
    return { text, toolCalls, usage, finishReason };
  }
}
