import { z } from 'zod';

/**
 * V1 工具入参 schema（PRD 附录 A）。
 * runtime 由此生成 JSON Schema 提供给模型；agent-tools 按此校验入参。
 */

export const ReadInput = z.object({
  path: z.string().describe('工作区内的相对路径'),
  offset: z.number().int().min(0).optional().describe('起始行号（0 起）'),
  limit: z.number().int().min(1).max(2000).optional().describe('读取行数，默认 500'),
});

export const WriteInput = z.object({
  path: z.string(),
  content: z.string(),
});

export const EditInput = z.object({
  path: z.string(),
  old: z.string().describe('必须与文件内容精确匹配且唯一'),
  new: z.string(),
  all: z.boolean().optional().describe('替换全部出现'),
});

export const GlobInput = z.object({
  pattern: z.string().describe('如 **/*.xlsx'),
});

export const GrepInput = z.object({
  pattern: z.string().describe('正则表达式'),
  path: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().int().max(200).optional(),
});

export const BashInput = z.object({
  command: z.string(),
  timeoutMs: z.number().int().max(600_000).optional().describe('默认 120000'),
  description: z.string().optional().describe('一句话说明该命令做什么'),
});

export const TodoWriteInput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      state: z.enum(['pending', 'in_progress', 'done', 'skipped']),
    }),
  ),
});

export const SkillInput = z.object({
  name: z.string().describe('技能名（来自可用技能目录）'),
  args: z.string().optional(),
});

export const AskUserQuestionInput = z.object({
  question: z.string(),
  options: z.array(z.string()).min(2).max(4),
});

export const WebFetchInput = z.object({
  url: z.string().url(),
  purpose: z.string().describe('抓取目的，用于审计'),
});

export const WebSearchInput = z.object({
  query: z.string(),
});

export const McpCallInput = z.object({
  server: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
});

export const ArtifactInput = z.object({
  path: z.string().describe('产物文件路径（工作区内）'),
  title: z.string(),
  kind: z
    .enum(['document', 'spreadsheet', 'slides', 'chart', 'page', 'data', 'other'])
    .default('other'),
});

export const AgentInput = z.object({
  prompt: z.string(),
  expert: z.string().optional().describe('专家模板名'),
});

export const ToolInputSchemas = {
  Read: ReadInput,
  Write: WriteInput,
  Edit: EditInput,
  Glob: GlobInput,
  Grep: GrepInput,
  Bash: BashInput,
  TodoWrite: TodoWriteInput,
  Skill: SkillInput,
  AskUserQuestion: AskUserQuestionInput,
  WebFetch: WebFetchInput,
  WebSearch: WebSearchInput,
  McpCall: McpCallInput,
  Artifact: ArtifactInput,
  Agent: AgentInput,
} as const;

export type ToolName = keyof typeof ToolInputSchemas;
export const ToolNames = Object.keys(ToolInputSchemas) as ToolName[];
