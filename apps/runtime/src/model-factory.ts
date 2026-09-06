import type { ChatModel } from './model.js';
import { OpenAICompatModel } from './model.js';
import { MockModel } from './mock-model.js';
import { ResilientModel } from './resilient-model.js';

export interface ModelConfig {
  model: string; // 'mock' 或具体模型名
  baseUrl?: string;
  apiKey?: string;
  /** 主模型重试耗尽后的降级模型（同一网关；如 deep → fast） */
  fallbackModel?: string;
}

/**
 * 按配置创建模型；model==='mock' 时用确定性 Mock。
 * 真实模型一律包一层 ResilientModel（T-409）：重试 + 降级 + 熔断。
 */
export function createModel(cfg: ModelConfig, fetchImpl?: typeof fetch): ChatModel {
  if (cfg.model === 'mock' || !cfg.baseUrl) return new MockModel();
  const key = cfg.apiKey ?? 'sk-none';
  const primary = new OpenAICompatModel(cfg.model, cfg.baseUrl, key, fetchImpl);
  const fallback =
    cfg.fallbackModel && cfg.fallbackModel !== cfg.model
      ? new OpenAICompatModel(cfg.fallbackModel, cfg.baseUrl, key, fetchImpl)
      : undefined;
  return new ResilientModel(primary, fallback);
}

export function modelConfigFromEnv(): ModelConfig {
  return {
    model: process.env.MODEL_DEFAULT ?? 'mock',
    baseUrl: process.env.MODEL_BASE_URL,
    apiKey: process.env.MODEL_API_KEY,
    fallbackModel: process.env.MODEL_FALLBACK || undefined,
  };
}
