import type { ChatModel } from './model.js';
import { OpenAICompatModel } from './model.js';
import { MockModel } from './mock-model.js';

export interface ModelConfig {
  model: string; // 'mock' 或具体模型名
  baseUrl?: string;
  apiKey?: string;
}

/** 按配置创建模型；model==='mock' 时用确定性 Mock。 */
export function createModel(cfg: ModelConfig): ChatModel {
  if (cfg.model === 'mock' || !cfg.baseUrl) return new MockModel();
  return new OpenAICompatModel(cfg.model, cfg.baseUrl, cfg.apiKey ?? 'sk-none');
}

export function modelConfigFromEnv(): ModelConfig {
  return {
    model: process.env.MODEL_DEFAULT ?? 'mock',
    baseUrl: process.env.MODEL_BASE_URL,
    apiKey: process.env.MODEL_API_KEY,
  };
}
