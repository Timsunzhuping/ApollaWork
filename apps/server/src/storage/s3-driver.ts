import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import type { StorageDriver, StoredObject } from './driver.js';

export interface S3Config {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

/**
 * S3 / MinIO 驱动（生产）。工作区对象前缀：`workspaces/{workspaceId}/`。
 * materialize 下载到本地临时目录供 Agent 执行；persist 把新增/变更文件写回。
 */
export class S3Driver implements StorageDriver {
  readonly kind = 's3' as const;
  private s3: S3Client;
  private bucket: string;
  private scratchRoot = path.join(os.tmpdir(), 'apolla-ws');
  /** materialize 时记录文件指纹，persist 时只上传变更，避免全量回写 */
  private snapshots = new Map<string, Map<string, string>>();

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region ?? 'us-east-1',
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      forcePathStyle: true, // MinIO 必需
    });
    fs.mkdirSync(this.scratchRoot, { recursive: true });
  }

  /** 启动时确保 bucket 存在（幂等）。 */
  async ensureBucket() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  private key(workspaceId: string, rel: string) {
    const norm = path.posix.normalize(rel).replace(/^(\.\.(\/|$))+/, '');
    if (norm.startsWith('..')) throw new Error('路径越界');
    return `workspaces/${workspaceId}/${norm}`;
  }

  private prefix(workspaceId: string) {
    return `workspaces/${workspaceId}/`;
  }

  async list(workspaceId: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix(workspaceId),
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key) continue;
        const rel = o.Key.slice(this.prefix(workspaceId).length);
        if (!rel || rel.startsWith('.')) continue;
        out.push({ path: rel, size: o.Size ?? 0 });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async read(workspaceId: string, rel: string): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(workspaceId, rel) }),
    );
    const chunks: Buffer[] = [];
    for await (const c of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  async write(workspaceId: string, rel: string, data: Buffer): Promise<number> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(workspaceId, rel), Body: data }),
    );
    return data.length;
  }

  async exists(workspaceId: string, rel: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(workspaceId, rel) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async remove(workspaceId: string, rel: string) {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(workspaceId, rel) }),
    );
  }

  /** 下载工作区到本地临时目录，供 Agent 直接读写。 */
  async materialize(workspaceId: string): Promise<string> {
    const dir = path.join(this.scratchRoot, workspaceId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const snap = new Map<string, string>();
    for (const obj of await this.list(workspaceId)) {
      const buf = await this.read(workspaceId, obj.path);
      const abs = path.join(dir, obj.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      snap.set(obj.path, hash(buf));
    }
    this.snapshots.set(workspaceId, snap);
    return dir;
  }

  /** 把本地目录中新增/变更的文件写回对象存储（按内容指纹跳过未变更项）。 */
  async persist(workspaceId: string, localDir: string) {
    const snap = this.snapshots.get(workspaceId) ?? new Map<string, string>();
    const files: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else files.push(path.relative(localDir, abs));
      }
    };
    walk(localDir);
    for (const rel of files) {
      const buf = fs.readFileSync(path.join(localDir, rel));
      const h = hash(buf);
      if (snap.get(rel) === h) continue; // 未变更
      await this.write(workspaceId, rel, buf);
      snap.set(rel, h);
    }
    this.snapshots.set(workspaceId, snap);
  }
}

function hash(b: Buffer) {
  return crypto.createHash('sha256').update(b).digest('hex');
}
