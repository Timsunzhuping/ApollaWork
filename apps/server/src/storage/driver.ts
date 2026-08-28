/**
 * 存储驱动抽象（生产 P0）。
 *
 * 关键设计：Agent 的工具直接对**本地目录**做 fs 读写（Read/Write/Bash 都是这样），
 * 所以对象存储不能直接当执行目录用。正确模型是：
 *   持久层（S3/MinIO 或 fs） --materialize--> 本地执行目录 --persist--> 持久层
 * fs 驱动下 materialize/persist 退化为零拷贝（执行目录即持久目录）。
 */
export interface StoredObject {
  path: string;
  size: number;
}

export interface StorageDriver {
  readonly kind: 'fs' | 's3';
  list(workspaceId: string): Promise<StoredObject[]>;
  read(workspaceId: string, rel: string): Promise<Buffer>;
  write(workspaceId: string, rel: string, data: Buffer): Promise<number>;
  exists(workspaceId: string, rel: string): Promise<boolean>;
  remove(workspaceId: string, rel: string): Promise<void>;
  /** 取一个可供 Agent 直接读写的本地目录（S3 下为临时目录并下载内容）。 */
  materialize(workspaceId: string): Promise<string>;
  /** 把本地目录的变更写回持久层（fs 驱动为 no-op）。 */
  persist(workspaceId: string, localDir: string): Promise<void>;
}
