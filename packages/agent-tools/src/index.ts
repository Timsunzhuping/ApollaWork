export * from './context.js';
export * from './paths.js';
export * from './truncate.js';
export * from './dangerous.js';
export { readTool, writeTool, editTool, globTool } from './tools/fs-tools.js';
export { grepTool } from './tools/grep.js';
export { bashTool } from './tools/bash.js';
export {
  todoWriteTool,
  askUserQuestionTool,
  artifactTool,
  webFetchTool,
  webSearchTool,
} from './tools/misc.js';

import type { ToolDef } from './context.js';
import { readTool, writeTool, editTool, globTool } from './tools/fs-tools.js';
import { grepTool } from './tools/grep.js';
import { bashTool } from './tools/bash.js';
import {
  todoWriteTool,
  askUserQuestionTool,
  artifactTool,
  webFetchTool,
  webSearchTool,
} from './tools/misc.js';

/** 基础工具集（Skill/McpCall/Agent 由 runtime 追加注册） */
export function baseTools(): ToolDef<any>[] {
  return [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
    todoWriteTool,
    askUserQuestionTool,
    artifactTool,
    webFetchTool,
    webSearchTool,
  ];
}
