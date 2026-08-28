import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { S3Driver } from './s3-driver.js';

/**
 * S3 驱动测试（生产 P0）。用内存假 S3 client 验证关键语义：
 * 对象前缀隔离、materialize 下载、persist 仅回写变更、路径越界防护。
 * 真实 MinIO 互通另行验证。
 */
class FakeS3 {
  objects = new Map<string, Buffer>();
  putCount = 0;

  async send(cmd: any): Promise<any> {
    const name = cmd.constructor.name;
    const i = cmd.input ?? {};
    if (name === 'HeadBucketCommand') return {};
    if (name === 'CreateBucketCommand') return {};
    if (name === 'PutObjectCommand') {
      this.putCount++;
      this.objects.set(i.Key, Buffer.from(i.Body));
      return {};
    }
    if (name === 'GetObjectCommand') {
      const b = this.objects.get(i.Key);
      if (!b) throw new Error('NoSuchKey');
      return { Body: (async function* () { yield b; })() };
    }
    if (name === 'HeadObjectCommand') {
      if (!this.objects.has(i.Key)) throw new Error('NotFound');
      return {};
    }
    if (name === 'DeleteObjectCommand') {
      this.objects.delete(i.Key);
      return {};
    }
    if (name === 'ListObjectsV2Command') {
      const contents = [...this.objects.entries()]
        .filter(([k]) => k.startsWith(i.Prefix))
        .map(([k, v]) => ({ Key: k, Size: v.length }));
      return { Contents: contents, IsTruncated: false };
    }
    throw new Error('unhandled ' + name);
  }
}

let fake: FakeS3;
let driver: S3Driver;
const cfg = { endpoint: 'http://fake', accessKey: 'a', secretKey: 'b', bucket: 'apolla' };

beforeEach(() => {
  fake = new FakeS3();
  driver = new S3Driver(cfg, fake as never);
});

describe('S3 存储驱动（修复：生产配 s3 但代码只有 fs → 静默丢数据）', () => {
  it('写入使用工作区前缀，不同空间互不可见', async () => {
    await driver.write('ws-a', 'report.md', Buffer.from('A 的内容'));
    await driver.write('ws-b', 'report.md', Buffer.from('B 的内容'));
    expect([...fake.objects.keys()].sort()).toEqual([
      'workspaces/ws-a/report.md',
      'workspaces/ws-b/report.md',
    ]);
    expect((await driver.read('ws-a', 'report.md')).toString()).toBe('A 的内容');
    const listA = await driver.list('ws-a');
    expect(listA.map((o) => o.path)).toEqual(['report.md']);
  });

  it('★ 路径越界（../）被拒绝，无法写到别的工作区', async () => {
    await expect(driver.write('ws-a', '../ws-b/steal.txt', Buffer.from('x'))).rejects.toThrow();
    await expect(driver.read('ws-a', '../../etc/passwd')).rejects.toThrow();
  });

  it('materialize 把对象下载成本地目录供 Agent 执行', async () => {
    await driver.write('ws-c', 'data/input.csv', Buffer.from('a,b\n1,2'));
    await driver.write('ws-c', 'note.txt', Buffer.from('hello'));
    const dir = await driver.materialize('ws-c');
    expect(fs.readFileSync(path.join(dir, 'data/input.csv'), 'utf8')).toBe('a,b\n1,2');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('hello');
  });

  it('★ persist 把 Agent 新建/修改的文件写回（否则产物会丢）', async () => {
    await driver.write('ws-d', 'seed.txt', Buffer.from('seed'));
    const dir = await driver.materialize('ws-d');
    // 模拟 Agent 在本地目录里干活
    fs.writeFileSync(path.join(dir, 'result.md'), '# 分析报告');
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed-modified');
    await driver.persist('ws-d', dir);

    expect((await driver.read('ws-d', 'result.md')).toString()).toBe('# 分析报告');
    expect((await driver.read('ws-d', 'seed.txt')).toString()).toBe('seed-modified');
  });

  it('persist 按内容指纹跳过未变更文件（避免全量回写）', async () => {
    await driver.write('ws-e', 'big.txt', Buffer.from('unchanged'));
    const dir = await driver.materialize('ws-e');
    const before = fake.putCount;
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
    await driver.persist('ws-e', dir);
    // 只应上传 new.txt 一个对象，big.txt 未变更不重传
    expect(fake.putCount - before).toBe(1);
  });

  it('persist 跳过 node_modules 与 .git', async () => {
    const dir = await driver.materialize('ws-f');
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'junk');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    await driver.persist('ws-f', dir);
    const keys = [...fake.objects.keys()];
    expect(keys.some((k) => k.includes('node_modules'))).toBe(false);
    expect(keys).toContain('workspaces/ws-f/keep.txt');
  });

  it('exists / remove 正常', async () => {
    await driver.write('ws-g', 'x.txt', Buffer.from('1'));
    expect(await driver.exists('ws-g', 'x.txt')).toBe(true);
    await driver.remove('ws-g', 'x.txt');
    expect(await driver.exists('ws-g', 'x.txt')).toBe(false);
  });
});
