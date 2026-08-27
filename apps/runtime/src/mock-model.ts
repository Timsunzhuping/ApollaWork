import type { ChatMessage, ChatModel, ModelDelta, ModelResult, ToolCall, ToolSpec } from './model.js';

/**
 * 确定性 Mock 模型：无 LLM 环境下跑通链路与评测。
 * 它读取最新一条 user 指令中的「[[ACTIONS]] ... [[/ACTIONS]]」脚本（JSON 数组），
 * 逐轮回放工具调用；工具结果回来后进入下一步。没有脚本则回一句文本。
 * 这让集成测试完全可复现，不依赖真实模型。
 */
interface ScriptStep {
  say?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

function parseScript(messages: ChatMessage[]): ScriptStep[] | null {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return null;
  // 贪婪匹配到最后一个 [[/ACTIONS]]：容忍脚本值内部再嵌套 [[ACTIONS]]（子代理场景）
  const m = firstUser.content.match(/\[\[ACTIONS\]\]([\s\S]*)\[\[\/ACTIONS\]\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim()) as ScriptStep[];
  } catch {
    return null;
  }
}

export class MockModel implements ChatModel {
  readonly name = 'mock';

  async chat(
    messages: ChatMessage[],
    _tools: ToolSpec[],
    onDelta: (d: ModelDelta) => void,
    _signal: AbortSignal,
  ): Promise<ModelResult> {
    const script = parseScript(messages);
    // 已执行的 assistant 工具轮数 = 已走到脚本的第几步
    const doneSteps = messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;

    if (script && doneSteps < script.length) {
      const step = script[doneSteps];
      const text = step.say ?? '';
      if (text) onDelta({ textDelta: text });
      const toolCalls: ToolCall[] = step.tool
        ? [{ id: `mock_${doneSteps}`, name: step.tool, arguments: JSON.stringify(step.args ?? {}) }]
        : [];
      return {
        text,
        toolCalls,
        usage: { inTokens: 10, outTokens: 5 },
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      };
    }

    const closing = script ? '任务完成。' : '（mock 模型）已收到，但没有可执行的脚本。';
    onDelta({ textDelta: closing });
    return { text: closing, toolCalls: [], usage: { inTokens: 10, outTokens: 5 }, finishReason: 'stop' };
  }
}
