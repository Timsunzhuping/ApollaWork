import net from 'node:net';

/**
 * ClamAV 病毒扫描（T-404，可选）：经 clamd 的 INSTREAM 协议扫内存中的文件，不落盘。
 * UPLOAD_SCAN=clamav 开启；CLAMAV_HOST/CLAMAV_PORT 指向 clamd（compose/helm 提供 sidecar）。
 * 开启后 clamd 不可达一律**拒绝上传**（fail-closed）：宁可上传失败，不可让病毒进工作区。
 */
export interface ClamOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface ScanResult {
  clean: boolean;
  signature?: string;
}

export function clamOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ClamOptions | null {
  if (env.UPLOAD_SCAN !== 'clamav') return null;
  return { host: env.CLAMAV_HOST ?? 'clamd', port: Number(env.CLAMAV_PORT ?? 3310), timeoutMs: Number(env.CLAMAV_TIMEOUT_MS ?? 30_000) };
}

/** 解析 clamd 回复：`stream: OK` / `stream: Eicar-Test-Signature FOUND` / `... ERROR` */
export function parseClamReply(reply: string): ScanResult {
  const line = reply.replace(/\0/g, '').trim();
  if (/\bOK$/.test(line)) return { clean: true };
  const found = /:\s*(.+?)\s+FOUND$/.exec(line);
  if (found) return { clean: false, signature: found[1] };
  throw new Error(`clamd 返回无法识别：${line || '(空)'}`);
}

export function scanBuffer(buf: Buffer, opts: ClamOptions): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: opts.host, port: opts.port });
    let reply = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('病毒扫描超时'))), opts.timeoutMs ?? 30_000);

    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      // 分块：4 字节大端长度 + 数据；0 长度表示结束
      const CHUNK = 64 * 1024;
      for (let off = 0; off < buf.length; off += CHUNK) {
        const piece = buf.subarray(off, Math.min(off + CHUNK, buf.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(piece.length, 0);
        sock.write(len);
        sock.write(piece);
      }
      sock.write(Buffer.from([0, 0, 0, 0]));
    });
    sock.on('data', (d) => {
      reply += d.toString();
      if (reply.includes('\0')) {
        done(() => {
          try {
            resolve(parseClamReply(reply));
          } catch (e) {
            reject(e);
          }
        });
      }
    });
    sock.on('end', () => done(() => {
      try {
        resolve(parseClamReply(reply));
      } catch (e) {
        reject(e);
      }
    }));
    sock.on('error', (e) => done(() => reject(new Error(`病毒扫描服务不可达：${e.message}`))));
  });
}
