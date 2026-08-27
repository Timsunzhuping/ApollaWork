import { baseTools, type ToolContext, type ToolDef } from '@apolla/agent-tools';
import { zodToJsonSchema } from './zod-json.js';
import type { ToolSpec } from './model.js';
import type { SkillManifest } from './skills.js';
import { findSkill } from './skills.js';
import { skillReminder } from './prompt.js';

/** 组装工具注册表（基础工具 + Skill + 未来 McpCall/Agent）。 */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private pendingSkillReminders: string[] = [];

  constructor(private skills: SkillManifest[]) {
    for (const t of baseTools()) this.tools.set(t.name, t);
    this.registerSkillTool();
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
      out.push({
        name: t.name,
        description: t.description,
        parameters: t.name === 'Skill' ? SKILL_SCHEMA : zodToJsonSchema(t.schema),
      });
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
