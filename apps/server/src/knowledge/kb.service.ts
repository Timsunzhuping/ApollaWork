import { Inject, Injectable, Logger } from '@nestjs/common';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, type AppConfig } from '../config.js';

const pexec = promisify(execFile);

/**
 * 资料库服务（PRD T-201/203）：每工作区一个 kb.db（{storage}/kb/{ws}.db）。
 * 解析/索引/检索委托给 apps/knowledge/kb_store.py（stdlib，无外部依赖）。
 * 工作区文件通过 base=workspaceId 入库；kb_mcp 连接器读同一 db。
 */
@Injectable()
export class KbService {
  private readonly log = new Logger('KB');
  private kbDir: string;
  private storeScript: string;

  constructor(@Inject(CONFIG) private config: AppConfig) {
    this.kbDir = path.join(this.config.storageDir, 'kb');
    fs.mkdirSync(this.kbDir, { recursive: true });
    // 定位 apps/knowledge/kb_store.py（相对 skillRoots[0] = <root>/skills）
    const guess = [
      path.resolve(this.config.skillRoots[0], '../apps/knowledge/kb_store.py'),
      path.resolve(process.cwd(), '../knowledge/kb_store.py'),
      path.resolve(process.cwd(), 'apps/knowledge/kb_store.py'),
    ];
    this.storeScript = guess.find((p) => fs.existsSync(p)) ?? guess[0];
  }

  private dbFor(workspaceId: string) {
    return path.join(this.kbDir, `${workspaceId}.db`);
  }

  private pyDir() {
    return path.dirname(this.storeScript);
  }

  /** 把工作区内一个文件加入知识库 */
  async ingest(workspaceId: string, absFilePath: string) {
    const db = this.dbFor(workspaceId);
    const code =
      `import sys; sys.path.insert(0, ${JSON.stringify(this.pyDir())}); ` +
      `import kb_store, json; ` +
      `print(json.dumps(kb_store.add_document(${JSON.stringify(workspaceId)}, ${JSON.stringify(absFilePath)}, ${JSON.stringify(db)})))`;
    const { stdout } = await pexec('python3', ['-c', code], { timeout: 120_000 });
    const line = stdout.trim().split('\n').pop() ?? '{}';
    return JSON.parse(line) as { doc: string; chunks: number; pages: number };
  }

  async listDocs(workspaceId: string) {
    const db = this.dbFor(workspaceId);
    if (!fs.existsSync(db)) return [];
    const code =
      `import sys; sys.path.insert(0, ${JSON.stringify(this.pyDir())}); ` +
      `import kb_store, json; print(json.dumps(kb_store.list_docs(${JSON.stringify(workspaceId)}, ${JSON.stringify(db)})))`;
    const { stdout } = await pexec('python3', ['-c', code], { timeout: 30_000 });
    const line = stdout.trim().split('\n').pop() ?? '[]';
    return JSON.parse(line) as { base: string; name: string; pages: number; chunks: number }[];
  }

  async search(workspaceId: string, query: string, k = 5) {
    const db = this.dbFor(workspaceId);
    if (!fs.existsSync(db)) return [];
    const code =
      `import sys; sys.path.insert(0, ${JSON.stringify(this.pyDir())}); ` +
      `import kb_store, json; print(json.dumps([h.to_dict() for h in kb_store.search(${JSON.stringify(query)}, base=${JSON.stringify(workspaceId)}, k=${k}, db_path=${JSON.stringify(db)})]))`;
    const { stdout } = await pexec('python3', ['-c', code], { timeout: 30_000 });
    const line = stdout.trim().split('\n').pop() ?? '[]';
    return JSON.parse(line) as { doc: string; page: number | null; text: string; score: number }[];
  }

  hasKb(workspaceId: string) {
    return fs.existsSync(this.dbFor(workspaceId));
  }
}
