export interface WaitForServerReadyOptions {
  /** 健康探测 URL，例如 http://127.0.0.1:3001/api/v1/me */
  url: string;
  /** 总超时（毫秒），默认 60000 */
  timeoutMs?: number;
  /** 轮询间隔（毫秒），默认 400 */
  intervalMs?: number;
  /** 注入 fetch（测试用）；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入 sleep（测试用）；默认真实定时器 */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * 判定「就绪」的谓词。默认：HTTP 200。
   * 之所以要求 200 而非任意响应：dev 认证下 /api/v1/me 只有在 seed 完成后才返回 200，
   * 未初始化时 AuthGuard 抛错 → Nest 返回 500。故 200 同时代表「已启动 + 已建库灌种子」。
   */
  isReady?: (status: number) => boolean;
  /** 每轮探测前调用；返回非空字符串则立刻中止并抛该错误（用于 server 子进程提前退出时快速失败）。 */
  shouldAbort?: () => string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 轮询探测 server 是否就绪。就绪返回 true；超时抛错（附最后一次错误信息）。
 */
export async function waitForServerReady(opts: WaitForServerReadyOptions): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 400;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const isReady = opts.isReady ?? ((status: number) => status === 200);

  const deadline = Date.now() + timeoutMs;
  let lastErr = '连接被拒绝（server 尚未监听）';

  while (Date.now() < deadline) {
    const abort = opts.shouldAbort?.();
    if (abort) throw new Error(abort);
    try {
      const res = await doFetch(opts.url);
      if (isReady(res.status)) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待本地服务就绪超时（${timeoutMs}ms）：${lastErr}`);
}
