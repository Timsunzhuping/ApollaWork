import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { clamOptionsFromEnv, parseClamReply, scanBuffer } from './clamav.js';

/**
 * ClamAV INSTREAM 客户端（T-404）。用一个假 clamd 复刻协议：
 * 读完 zINSTREAM + 分块 + 0 结束符后，按内容决定回 OK 还是 FOUND。
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function fakeClamd(): Promise<{ port: number; close: () => void; received: Buffer[] }> {
  const received: Buffer[] = [];
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      received.push(d);
      // 协议结束：出现 4 字节 0 长度块
      if (buf.length >= 4 && buf.subarray(-4).equals(Buffer.from([0, 0, 0, 0]))) {
        const body = buf.toString('binary');
        const verdict = body.includes('EICAR-STANDARD') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0';
        sock.end(verdict);
      }
    });
  });
  return new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => r({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close(), received })),
  );
}

describe('clamav', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((f) => f()));

  it('parseClamReply：OK / FOUND / 其他', () => {
    expect(parseClamReply('stream: OK\0')).toEqual({ clean: true });
    expect(parseClamReply('stream: Eicar-Test-Signature FOUND\0')).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
    expect(() => parseClamReply('INSTREAM size limit exceeded. ERROR')).toThrow('无法识别');
  });

  it('★ 干净文件 → clean；协议帧以 zINSTREAM 开头、0 长度块结束', async () => {
    const c = await fakeClamd();
    cleanups.push(c.close);
    const r = await scanBuffer(Buffer.from('hello world'), { host: '127.0.0.1', port: c.port });
    expect(r.clean).toBe(true);
    const all = Buffer.concat(c.received);
    expect(all.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(all.readUInt32BE(10)).toBe('hello world'.length);
  });

  it('★ EICAR 样本 → FOUND，带签名名', async () => {
    const c = await fakeClamd();
    cleanups.push(c.close);
    const r = await scanBuffer(Buffer.from(EICAR), { host: '127.0.0.1', port: c.port });
    expect(r).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });

  it('大文件分多块发送，长度前缀正确', async () => {
    const c = await fakeClamd();
    cleanups.push(c.close);
    const big = Buffer.alloc(150 * 1024, 'a');
    const r = await scanBuffer(big, { host: '127.0.0.1', port: c.port });
    expect(r.clean).toBe(true);
    const all = Buffer.concat(c.received);
    // 10 字节命令 + (4+65536)*2 + (4+22528) + 4 结束
    expect(all.length).toBe(10 + (4 + 65536) * 2 + (4 + 150 * 1024 - 2 * 65536) + 4);
  });

  it('★ clamd 不可达 → 抛错（调用方 fail-closed 拒绝上传）', async () => {
    await expect(scanBuffer(Buffer.from('x'), { host: '127.0.0.1', port: 1, timeoutMs: 2000 })).rejects.toThrow(/不可达/);
  });

  it('clamOptionsFromEnv：未开启返回 null，开启读主机端口', () => {
    expect(clamOptionsFromEnv({})).toBeNull();
    expect(clamOptionsFromEnv({ UPLOAD_SCAN: 'clamav', CLAMAV_HOST: 'av', CLAMAV_PORT: '3311' })).toMatchObject({ host: 'av', port: 3311 });
  });
});
