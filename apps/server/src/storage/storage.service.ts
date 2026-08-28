import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import path from 'node:path';
import { CONFIG, type AppConfig } from '../config.js';
import type { StorageDriver, StoredObject } from './driver.js';
import { FsDriver } from './fs-driver.js';
import { S3Driver } from './s3-driver.js';

/**
 * 工作区文件存储（生产 P0 修复）。
 * 之前只有 fs 实现，而 compose.prod 配的是 STORAGE_DRIVER=s3 —— 生产会把文件写进
 * 容器本地盘，重启即丢。现按配置真正切换驱动，并提供 materialize/persist 供任务执行使用。
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger('Storage');
  private driver: StorageDriver;

  constructor(@Inject(CONFIG) private config: AppConfig) {
    if (config.storageDriver === 's3') {
      this.driver = new S3Driver({
        endpoint: config.s3.endpoint,
        accessKey: config.s3.accessKey,
        secretKey: config.s3.secretKey,
        bucket: config.s3.bucket,
      });
    } else {
      this.driver = new FsDriver(path.join(config.storageDir, 'workspaces'));
    }
  }

  async onModuleInit() {
    if (this.driver instanceof S3Driver) {
      await this.driver.ensureBucket();
      this.log.log(`存储：S3/MinIO ${this.config.s3.endpoint} bucket=${this.config.s3.bucket}`);
    } else {
      this.log.log(`存储：本地文件系统 ${this.config.storageDir}`);
    }
  }

  get kind() {
    return this.driver.kind;
  }

  /** 取任务执行用的本地目录（S3 下会先下载）。 */
  materialize(workspaceId: string): Promise<string> {
    return this.driver.materialize(workspaceId);
  }

  /** 任务结束后把本地变更写回持久层（fs 下为 no-op）。 */
  persist(workspaceId: string, localDir: string): Promise<void> {
    return this.driver.persist(workspaceId, localDir);
  }

  list(workspaceId: string): Promise<StoredObject[]> {
    return this.driver.list(workspaceId);
  }

  readFile(workspaceId: string, rel: string): Promise<Buffer> {
    return this.driver.read(workspaceId, rel);
  }

  writeFile(workspaceId: string, rel: string, data: Buffer | string): Promise<number> {
    return this.driver.write(workspaceId, rel, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  exists(workspaceId: string, rel: string): Promise<boolean> {
    return this.driver.exists(workspaceId, rel);
  }

  remove(workspaceId: string, rel: string): Promise<void> {
    return this.driver.remove(workspaceId, rel);
  }

  /**
   * 仅 fs 驱动可用的绝对路径（KB 入库等本地处理场景）。
   * S3 驱动下调用方应改用 readFile 拿内容。
   */
  absPathIfLocal(workspaceId: string, rel: string): string | null {
    if (this.driver instanceof FsDriver) return this.driver.absPath(workspaceId, rel);
    return null;
  }
}
