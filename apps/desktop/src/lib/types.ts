/**
 * 桌面端本地执行模式的共享类型。
 * 本文件（及 lib/ 下所有模块）不得 import 'electron'——保持纯逻辑，方便在无显示环境下用 node 单测。
 */

/** 用户可配置的模型设置（持久化到 userData/settings.json）。 */
export interface ModelSettings {
  /** OpenAI 兼容端点，如 http://localhost:11434/v1 */
  MODEL_BASE_URL?: string;
  /** 端点 API Key（本地 Ollama 可随意填） */
  MODEL_API_KEY?: string;
  /** 默认模型名，如 qwen3:8b；mock=内置确定性模型（无需 LLM） */
  MODEL_DEFAULT?: string;
}

/** settings.json 中允许持久化的键（白名单，避免写入无关字段）。 */
export const SETTINGS_KEYS = ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_DEFAULT'] as const;

/** 解析出的一组关键路径（随开发/打包两种形态不同而不同）。 */
export interface ResolvedPaths {
  /** 被拉起的 server 入口：apps/server/dist/main.js（或打包后的镜像） */
  serverMain: string;
  /** server 子进程的工作目录（决定 config.ts 里 skillRoots / dotenv 的定位） */
  serverCwd: string;
  /** 前端静态资源目录（apps/web/dist），注入为 WEB_DIST */
  webDist: string;
  /** prisma schema 路径（db push 用） */
  schemaPath: string;
  /** seed 脚本路径（首次建库后灌入种子数据） */
  seedPath: string;
  /** prisma CLI 可执行文件 */
  prismaBin: string;
  /** tsx 可执行文件（用于跑 TypeScript 的 seed.ts） */
  tsxBin: string;
  /** 技能目录（仅用于校验/日志；server 依据 cwd 自行定位） */
  skillsDir: string;
  /** runtime 目录（本地执行器会用到） */
  runtimeDir: string;
}
