import { describe, expect, it } from 'vitest';
import { DockerExecutor } from './docker-executor.js';
import type { ExecRequest } from './executor.js';
import type { AppConfig } from '../config.js';

/**
 * 沙箱容器安全配置测试（生产 P0#4）。
 *
 * 真实镜像构建受限于本机镜像源，无法跑通容器；但**容器怎么被创建**是可测的，
 * 而这恰恰是生产隔离的关键：非 root、PID 上限、禁提权、只挂工作区、密钥不外泄。
 * 这些配置错了，即便镜像构建成功，隔离也是纸糊的。
 */
const config = {
  sandboxImage: 'apolla-sandbox:1.0',
  webfetchAllowlist: [],
} as unknown as AppConfig;

const req: ExecRequest = {
  taskId: 'task-1',
  sessionId: 'ses-1',
  prompt: '分析这份财报',
  workspaceDir: '/data/storage/workspaces/ws-1',
  mode: 'ask',
  modelTier: 'auto',
  attachments: [],
  model: { name: 'qwen3', baseUrl: 'http://litellm:4000/v1', apiKey: 'sk-secret' },
  skillRoots: ['/opt/apolla/skills'],
  webfetchAllowlist: ['docs.corp.com'],
};

const exec = new DockerExecutor(config, {} as never);
const spec = exec.buildContainerSpec(req, 'tok-abc');

describe('沙箱容器安全配置', () => {
  it('★ 非 root 运行', () => {
    expect(spec.User).toBe('1001:1001');
  });

  it('★ 限制 PID 数量（防 fork bomb 耗尽宿主）', () => {
    expect(spec.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(spec.HostConfig.PidsLimit).toBeLessThanOrEqual(1024);
  });

  it('★ 禁止提权（no-new-privileges）', () => {
    expect(spec.HostConfig.SecurityOpt).toContain('no-new-privileges');
  });

  it('★ 只挂载该任务自己的工作区，不挂宿主其他路径', () => {
    expect(spec.HostConfig.Binds).toEqual(['/data/storage/workspaces/ws-1:/workspace']);
    // 不得出现 docker.sock、根目录等危险挂载
    for (const b of spec.HostConfig.Binds) {
      expect(b).not.toContain('docker.sock');
      expect(b).not.toMatch(/^\/:/);
      expect(b).not.toContain('/etc:');
    }
  });

  it('★ 内存与 CPU 有上限（防单任务拖垮节点）', () => {
    expect(spec.HostConfig.Memory).toBeGreaterThan(0);
    expect(spec.HostConfig.NanoCpus).toBeGreaterThan(0);
  });

  it('容器退出即回收，不留残骸', () => {
    expect(spec.HostConfig.AutoRemove).toBe(true);
  });

  it('工作目录为 /workspace，入口为 headless runtime', () => {
    expect(spec.WorkingDir).toBe('/workspace');
    expect(spec.Cmd.join(' ')).toContain('sandbox-main.js');
  });

  it('用配置的镜像标签（生产应固定版本而非 dev）', () => {
    expect(spec.Image).toBe('apolla-sandbox:1.0');
  });

  it('任务令牌与权限模式正确注入', () => {
    expect(spec.Env).toContain('APOLLA_TOKEN=tok-abc');
    expect(spec.Env).toContain('APOLLA_MODE=ask');
    expect(spec.Env).toContain('APOLLA_TASK_ID=task-1');
  });

  it('prompt 经 base64 传递（避免 shell 注入与换行截断）', () => {
    const line = spec.Env.find((e) => e.startsWith('APOLLA_PROMPT_B64='))!;
    const decoded = Buffer.from(line.split('=')[1], 'base64').toString('utf8');
    expect(decoded).toBe('分析这份财报');
  });

  it('出网白名单按任务下发（默认为空即全禁）', () => {
    expect(spec.Env).toContain('WEBFETCH_ALLOWLIST=docs.corp.com');
    const noNet = exec.buildContainerSpec({ ...req, webfetchAllowlist: [] });
    expect(noNet.Env).toContain('WEBFETCH_ALLOWLIST=');
  });


  // ---- T-402 网络隔离：红线「默认禁出网」的容器层机制 ----
  it('★ 容器无网络接口（NetworkMode none），出网只能经 server 中继', () => {
    expect(spec.HostConfig.NetworkMode).toBe('none');
  });

  it('★ 不再把宿主暴露给容器（无 host.docker.internal 映射）', () => {
    expect((spec.HostConfig as { ExtraHosts?: string[] }).ExtraHosts).toBeUndefined();
  });

  it('★ 模型 API Key 不进容器（由 server 中继时注入）', () => {
    expect(spec.Env.some((e: string) => e.startsWith('MODEL_API_KEY='))).toBe(false);
    expect(spec.Env).toContain('MODEL_DEFAULT=' + req.model.name);
  });

  it('控制通道走 stdio：开 stdin、附着 stdout/stderr、非 TTY', () => {
    expect(spec.OpenStdin).toBe(true);
    expect(spec.AttachStdin).toBe(true);
    expect(spec.AttachStdout).toBe(true);
    expect(spec.Tty).toBe(false);
    expect(spec.Env).toContain('APOLLA_PROXY_PORT=3128');
  });
});
