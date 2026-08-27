import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { CONFIG, type AppConfig } from '../config.js';
import { encryptSecret, decryptSecret } from '../common/crypto.js';

export interface ResolvedModel {
  name: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 模型治理（PRD T-011/T-119）：模型接入配置存库（密钥信封加密），
 * 按档位（auto/fast/deep）路由。DB 无配置时回落到环境变量（config.model / modelTiers）。
 * 让管理员「配上模型 API 即可使用」——无需改环境重启。
 */
@Injectable()
export class ModelService {
  constructor(
    private prisma: PrismaService,
    @Inject(CONFIG) private config: AppConfig,
  ) {}

  async list(orgId: string) {
    const rows = await this.prisma.modelProvider.findMany({ where: { orgId } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      model: r.model,
      tier: r.tier,
      enabled: r.enabled,
      hasKey: !!r.keyEnc,
    }));
  }

  async upsert(input: {
    id?: string;
    orgId: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    tier: string;
    enabled?: boolean;
  }) {
    const data = {
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      tier: input.tier,
      enabled: input.enabled ?? true,
      ...(input.apiKey ? { keyEnc: encryptSecret(input.apiKey) } : {}),
    };
    if (input.id) return this.prisma.modelProvider.update({ where: { id: input.id }, data });
    return this.prisma.modelProvider.create({ data: { orgId: input.orgId, ...data } });
  }

  async remove(id: string) {
    await this.prisma.modelProvider.delete({ where: { id } });
  }

  /** 解析某档位应使用的模型（DB 优先，回落 env）。 */
  async resolve(orgId: string, tier: string): Promise<ResolvedModel> {
    const wanted = tier === 'auto' ? ['deep', 'auto', 'fast'] : [tier];
    for (const t of wanted) {
      const row = await this.prisma.modelProvider.findFirst({
        where: { orgId, tier: t, enabled: true },
      });
      if (row) {
        return {
          name: row.model,
          baseUrl: row.baseUrl,
          apiKey: row.keyEnc ? decryptSecret(row.keyEnc) : undefined,
        };
      }
    }
    // 回落环境变量
    const { model, modelTiers } = this.config;
    const name = tier === 'fast' ? modelTiers.fast : tier === 'deep' ? modelTiers.deep : undefined;
    return { name: name ?? model.name, baseUrl: model.baseUrl, apiKey: model.apiKey };
  }

  /** 连通性测试：向端点发一个最小 chat 请求。 */
  async test(id: string): Promise<{ ok: boolean; error?: string; reply?: string }> {
    const row = await this.prisma.modelProvider.findUnique({ where: { id } });
    if (!row) return { ok: false, error: 'not found' };
    const apiKey = row.keyEnc ? decryptSecret(row.keyEnc) : 'none';
    try {
      const res = await fetch(`${row.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: row.model,
          messages: [{ role: 'user', content: '说“ok”' }],
          max_tokens: 16,
          stream: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return { ok: true, reply: (j.choices?.[0]?.message?.content ?? '').slice(0, 80) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
