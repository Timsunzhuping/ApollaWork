import { baseTools, ok, fail, type ToolContext, type ToolDef } from '@apolla/agent-tools';
import { zodToJsonSchema } from './zod-json.js';
import type { ToolSpec } from './model.js';
import type { SkillManifest } from './skills.js';
import { findSkill } from './skills.js';
import { skillReminder } from './prompt.js';
import type { McpStdioClient, McpTool } from './mcp-client.js';

/** 组装工具注册表（基础工具 + Skill + MCP 连接器 + 未来 Agent）。 */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private pendingSkillReminders: string[] = [];
  private mcpSchemas = new Map<string, Record<string, unknown>>();

  constructor(
    private skills: SkillManifest[],
    mcpTools: McpTool[] = [],
    mcpClients: Map<string, McpStdioClient> = new Map(),
  ) {
    for (const t of baseTools()) this.tools.set(t.name, t);
    this.registerSkillTool();
    this.registerMcpTools(mcpTools, mcpClients);
  }

  /** 把每个 MCP 工具注册成一个可调用工具 mcp__<server>__<tool>（PRD T-109）。 */
  private registerMcpTools(mcpTools: McpTool[], clients: Map<string, McpStdioClient>) {
    for (const mt of mcpTools) {
      const client = clients.get(mt.server);
      if (!client) continue;
      this.mcpSchemas.set(mt.qualifiedName, mt.inputSchema);
      this.tools.set(mt.qualifiedName, {
        name: mt.qualifiedName as never,
        description: `[连接器 ${mt.server}] ${mt.description}`,
        schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
        async execute(input: Record<string, unknown>, ctx) {
          // 连接器写操作在 ask 模式下审批
          if (ctx.mode === 'ask') {
            const approved = await ctx.requestApproval({
              kind: 'connector_write',
              title: `调用连接器 ${mt.server}.${mt.name}`,
              detail: JSON.stringify(input).slice(0, 300),
            });
            if (!approved) return fail('用户拒绝了连接器调用。');
          }
          try {
            return ok(await client.callTool(mt.name, input ?? {}));
          } catch (e) {
            return fail(`连接器调用失败：${(e as Error).message}`);
          }
        },
      });
    }
  }

  private registerSkillTool() {
    const skills = this.skills;
    const self = this;
    this.tools.set('Skill', {
      name: 'Skill',
      description:
        '加载一个技能的详细操作说明。参数 name 取自系统提示词「可用技能」列表。加载后按其说明执行。',
      schema: { parse: (v: unknown) => v } as never, // 由 loop 前置校验
      async execute(input: { name: string }) {
        const skill = findSkill(skills, input.name);
        if (!skill) {
          return { ok: false, output: `未找到技能：${input.name}。可用：${skills.map((s) => s.name).join(', ')}` };
        }
        self.pendingSkillReminders.push(skillReminder(skill));
        return { ok: true, output: `技能「${skill.name}」已加载，其操作说明已注入对话，请遵循执行。` };
      },
    });
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  /** 供模型使用的工具规格（JSON Schema） */
  specs(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const t of this.tools.values()) {
      let parameters: Record<string, unknown>;
      if (t.name === 'Skill') parameters = SKILL_SCHEMA;
      else if (this.mcpSchemas.has(t.name)) parameters = this.mcpSchemas.get(t.name)!;
      else parameters = zodToJsonSchema(t.schema);
      out.push({ name: t.name, description: t.description, parameters });
    }
    return out;
  }

  /** 取出 Skill 工具产生的、待注入对话的系统提醒 */
  drainSkillReminders(): string[] {
    const r = this.pendingSkillReminders;
    this.pendingSkillReminders = [];
    return r;
  }
}

const SKILL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '技能名' },
    args: { type: 'string', description: '可选参数' },
  },
  required: ['name'],
  additionalProperties: false,
};

export type { ToolContext };
