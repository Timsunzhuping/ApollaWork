import net from 'node:net';

/** 探测某端口在指定 host 上是否可被监听（空闲）。 */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * 从 start 起向上探测第一个空闲端口。
 * @throws 若在 maxTries 内找不到空闲端口。
 */
export async function findFreePort(start = 3001, host = '127.0.0.1', maxTries = 200): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`未找到空闲端口（从 ${start} 起尝试了 ${maxTries} 次）`);
}
