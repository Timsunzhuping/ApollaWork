# ADR-003 · server 以编译产物运行，不用 tsx

**背景**：NestJS 依赖 `reflect-metadata` 的 `design:paramtypes` 做构造函数注入。`tsx`（基于 esbuild）**不发出** `emitDecoratorMetadata`，导致 DI 解析失败（`Nest can't resolve dependencies`）。

**决策**：
- server 开发与生产都用 `tsc` 编译后 `node dist/main.js` 运行（`tsc` 正确发出装饰器元数据）。
- 需要热重载时用 `tsc -w` + `node --watch`，而非 tsx。
- runtime / eval / seed 等非 Nest 代码仍可用 tsx（无装饰器元数据依赖）。

**后果**：server 的 `dev` 脚本改为编译型；启动多一步编译，但避免了运行期 DI 崩溃。若未来引入 SWC（支持 emitDecoratorMetadata）可重新评估用 SWC 做即时执行。
